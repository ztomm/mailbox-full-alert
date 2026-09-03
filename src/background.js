/* global browser */

const MFA_DEFAULT_CHECK_INTERVAL_MIN = 360;
const MFA_DEFAULT_THRESHOLD_PCT = 80;
const MFA_NOTIFY_STATE_KEY_PREFIX = 'MFA_lastNotifiedPct_';
const MFA_GLOBAL_INTERVAL_KEY = 'MFA_globalIntervalMin';
const MFA_ACCOUNT_STATUS_KEY = 'MFA_accountStatus';
const MFA_SHOW_ONBOARDING_KEY = 'MFA_showOnboarding';
const MFA_NOTIFICATION_ID_PREFIX = 'quota-';
const MFA_ALARM_NAME = 'quota-check';

let operationQueue = Promise.resolve();

function formatBytes(bytes) {
	let value = Number(bytes) || 0;
	let unit = 'byte';
	let divisor = 1;

	if (value >= 1024 ** 3) {
		unit = 'gigabyte';
		divisor = 1024 ** 3;
	} else if (value >= 1024 ** 2) {
		unit = 'megabyte';
		divisor = 1024 ** 2;
	} else if (value >= 1024) {
		unit = 'kilobyte';
		divisor = 1024;
	}

	try {
		return new Intl.NumberFormat(browser.i18n.getUILanguage(), {
			style: 'unit', unit, unitDisplay: 'short',
			maximumFractionDigits: divisor === 1 ? 0 : 1
		}).format(value / divisor);
	} catch (error) {
		let labels = { byte: 'B', kilobyte: 'KB', megabyte: 'MB', gigabyte: 'GB' };
		return `${(value / divisor).toFixed(divisor === 1 ? 0 : 1)} ${labels[unit]}`;
	}
}

async function sumFolderMessagesSize(folder) {
	let total = 0;
	let page = await browser.messages.list(folder);
	while (true) {
		for (let message of page.messages) {
			if (typeof message.size === 'number') total += message.size;
		}
		if (!page.id) break;
		page = await browser.messages.continueList(page.id);
	}
	return total;
}

async function sumAccountBytes(accountId) {
	let account = await browser.accounts.get(accountId, true);
	if (!account?.rootFolder) return 0;
	let total = 0;
	async function walk(folder) {
		total += await sumFolderMessagesSize(folder);
		let children = Array.isArray(folder.subFolders)
			? folder.subFolders
			: await browser.folders.getSubFolders(folder);
		for (let child of children) await walk(child);
	}
	await walk(account.rootFolder);
	return total;
}

async function getPerAccountConfig() {
	let { perAccount = {} } = await browser.storage.local.get({ perAccount: {} });
	return perAccount;
}

async function getAccountStatus() {
	let result = await browser.storage.local.get({ [MFA_ACCOUNT_STATUS_KEY]: {} });
	return result[MFA_ACCOUNT_STATUS_KEY] || {};
}

async function getGlobalIntervalMin() {
	let result = await browser.storage.local.get({ [MFA_GLOBAL_INTERVAL_KEY]: MFA_DEFAULT_CHECK_INTERVAL_MIN });
	let value = result[MFA_GLOBAL_INTERVAL_KEY];
	return Number.isFinite(value) ? value : MFA_DEFAULT_CHECK_INTERVAL_MIN;
}

function notificationId(accountId) {
	return `${MFA_NOTIFICATION_ID_PREFIX}${accountId}`;
}

function isMonitoringActive(account, config) {
	if (typeof config.active === 'boolean') return config.active;
	return account.type === 'imap';
}

async function clearNotification(accountId) {
	try {
		await browser.notifications.clear(notificationId(accountId));
	} catch (error) {
		console.error('[MFA] Could not clear notification', accountId, error);
	}
}

async function showNotification(account, used, limit, pctUsed, threshold) {
	let title = browser.i18n.getMessage('notifyTitle', account.name || account.id);
	let line1 = browser.i18n.getMessage('notifyLineUsed', [
		formatBytes(used), formatBytes(limit), pctUsed.toFixed(1)
	]);
	let line2 = browser.i18n.getMessage('notifyLineThreshold', [`${threshold}%`]);
	await browser.notifications.create(notificationId(account.id), {
		type: 'basic', iconUrl: 'icons/icon-96.png', title,
		message: `${line1}\n${line2}`
	});
}

async function updateBadge(accounts, perAccount, statuses) {
	let critical = [];
	let incomplete = [];
	for (let account of accounts) {
		let config = perAccount[account.id] || {};
		let active = isMonitoringActive(account, config);
		let limit = Number(config.limitBytes || 0);
		if (!active) continue;
		if (!(limit > 0)) {
			incomplete.push(account);
			continue;
		}
		let status = statuses[account.id];
		let threshold = Number.isFinite(config.thresholdPct) ? config.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT;
		if (status && Number(status.pctUsed) >= threshold) {
			critical.push({ account, percent: Math.floor(Number(status.pctUsed)) });
		}
	}

	if (critical.length) {
		critical.sort((a, b) => b.percent - a.percent);
		let top = critical[0];
		let badgeText = top.percent > 999 ? '999+' : `${top.percent}%`;
		await browser.browserAction.setBadgeText({ text: badgeText });
		await browser.browserAction.setBadgeBackgroundColor({ color: '#c62828' });
		await browser.browserAction.setTitle({ title: top.account.name || top.account.id });
		return;
	}

	if (incomplete.length) {
		await browser.browserAction.setBadgeText({ text: '!' });
		await browser.browserAction.setBadgeBackgroundColor({ color: '#e6a700' });
		await browser.browserAction.setTitle({
			title: browser.i18n.getMessage('badgeSetupTitle', String(incomplete.length)) || 'Setup required'
		});
		return;
	}

	await browser.browserAction.setBadgeText({ text: '' });
	await browser.browserAction.setTitle({ title: browser.i18n.getMessage('extShortName') || 'MFA' });
}

function buildUsageSnapshot(accounts, perAccount, statuses) {
	return accounts.map(account => {
		let config = perAccount[account.id] || {};
		let status = statuses[account.id] || {};
		return {
			id: account.id,
			name: account.name || account.id,
			type: account.type || '',
			active: isMonitoringActive(account, config),
			limitBytes: Number(config.limitBytes || 0),
			thresholdPct: Number.isFinite(config.thresholdPct) ? config.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT,
			usedBytes: Number(status.usedBytes || 0),
			pctUsed: Number(status.pctUsed || 0),
			checkedAt: Number(status.checkedAt || 0),
			error: status.error || ''
		};
	});
}

async function performCheck({ onlyAccountId = null } = {}) {
	let accounts = await browser.accounts.list();
	let perAccount = await getPerAccountConfig();
	let statuses = await getAccountStatus();
	let existingIds = new Set(accounts.map(account => account.id));
	for (let accountId of Object.keys(statuses)) {
		if (!existingIds.has(accountId)) delete statuses[accountId];
	}

	for (let account of accounts) {
		if (onlyAccountId && account.id !== onlyAccountId) continue;
		let config = perAccount[account.id] || {};
		let active = isMonitoringActive(account, config);
		let limit = Number(config.limitBytes || 0);
		let threshold = Number.isFinite(config.thresholdPct) ? config.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT;
		let notifyKey = `${MFA_NOTIFY_STATE_KEY_PREFIX}${account.id}`;

		if (!active || !(limit > 0)) {
			delete statuses[account.id];
			await clearNotification(account.id);
			await browser.storage.local.set({ [notifyKey]: 0 });
			continue;
		}

		try {
			let used = await sumAccountBytes(account.id);
			let pctUsed = (used / limit) * 100;
			let previous = await browser.storage.local.get({ [notifyKey]: 0 });
			let lastPct = Number(previous[notifyKey] || 0);
			let crossedThreshold = pctUsed >= threshold && lastPct < threshold;
			if (pctUsed < threshold) await clearNotification(account.id);
			if (crossedThreshold) await showNotification(account, used, limit, pctUsed, threshold);
			statuses[account.id] = {
				usedBytes: used,
				pctUsed: Math.round(pctUsed * 10) / 10,
				checkedAt: Date.now(), error: ''
			};
			await browser.storage.local.set({ [notifyKey]: Math.round(pctUsed * 10) / 10 });
		} catch (error) {
			console.error('[MFA] Check failed for account', account.id, error);
			statuses[account.id] = {
				...(statuses[account.id] || {}),
				error: String(error?.message || error)
			};
		}
	}

	await browser.storage.local.set({ [MFA_ACCOUNT_STATUS_KEY]: statuses });
	await updateBadge(accounts, perAccount, statuses);
	return buildUsageSnapshot(accounts, perAccount, statuses);
}

function queueOperation(task) {
	let queued = operationQueue.then(task);
	operationQueue = queued.catch(() => {});
	return queued;
}

function queueCheck(options = {}) {
	return queueOperation(() => performCheck(options));
}

async function saveAccountsConfig(nextPartial) {
	let current = await getPerAccountConfig();
	let statuses = await getAccountStatus();
	for (let [accountId, next] of Object.entries(nextPartial || {})) {
		let previous = current[accountId] || {};
		let normalized = {
			active: next.active !== false,
			limitBytes: Math.max(0, Number(next.limitBytes || 0)),
			thresholdPct: Number.isFinite(next.thresholdPct) ? next.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT
		};
		current[accountId] = { ...previous, ...normalized };
		let monitoringChanged = Number(previous.limitBytes || 0) !== normalized.limitBytes || previous.active !== normalized.active;
		let thresholdChanged = Number(previous.thresholdPct || MFA_DEFAULT_THRESHOLD_PCT) !== normalized.thresholdPct;
		if (monitoringChanged) {
			delete statuses[accountId];
		}
		if (monitoringChanged || thresholdChanged) {
			await clearNotification(accountId);
			await browser.storage.local.set({ [`${MFA_NOTIFY_STATE_KEY_PREFIX}${accountId}`]: 0 });
		}
	}
	await browser.storage.local.set({ perAccount: current, [MFA_ACCOUNT_STATUS_KEY]: statuses });
	let accounts = await browser.accounts.list();
	await updateBadge(accounts, current, statuses);
	return buildUsageSnapshot(accounts, current, statuses);
}

async function scheduleChecksFromSettings() {
	try {
		let minutesRaw = await getGlobalIntervalMin();
		await browser.alarms.clear(MFA_ALARM_NAME);
		let minutes = Math.max(0, Math.floor(Number(minutesRaw) || 0));
		if (minutes > 0) {
			await browser.alarms.create(MFA_ALARM_NAME, { periodInMinutes: Math.max(1, minutes) });
		}
	} catch (error) {
		console.error('[MFA] Failed to schedule checks', error);
	}
}

browser.runtime.onInstalled.addListener(async details => {
	if (details.reason === 'install') {
		await browser.storage.local.set({ [MFA_SHOW_ONBOARDING_KEY]: true });
		await browser.runtime.openOptionsPage();
	} else {
		let stored = await browser.storage.local.get(MFA_SHOW_ONBOARDING_KEY);
		if (!(MFA_SHOW_ONBOARDING_KEY in stored)) {
			await browser.storage.local.set({ [MFA_SHOW_ONBOARDING_KEY]: false });
		}
	}
	await scheduleChecksFromSettings();
	queueCheck().catch(console.error);
});

browser.runtime.onStartup.addListener(async () => {
	await scheduleChecksFromSettings();
	queueCheck().catch(console.error);
});

browser.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === MFA_ALARM_NAME) queueCheck().catch(console.error);
});

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

browser.runtime.onMessage.addListener(async message => {
	if (message?.type === 'getAccountsState') {
		let accounts = await browser.accounts.list();
		return buildUsageSnapshot(accounts, await getPerAccountConfig(), await getAccountStatus());
	}
	if (message?.type === 'saveAccountsConfig') {
		return { ok: true, usage: await queueOperation(() => saveAccountsConfig(message.payload || {})) };
	}
	if (message?.type === 'runCheckNow') {
		return { ok: true, usage: await queueCheck({ onlyAccountId: message.accountId || null }) };
	}
	if (message?.type === 'getGlobalSettings') {
		let result = await browser.storage.local.get({ [MFA_SHOW_ONBOARDING_KEY]: false });
		return {
			intervalMin: await getGlobalIntervalMin(),
			showOnboarding: result[MFA_SHOW_ONBOARDING_KEY] === true
		};
	}
	if (message?.type === 'dismissOnboarding') {
		await browser.storage.local.set({ [MFA_SHOW_ONBOARDING_KEY]: false });
		return { ok: true };
	}
	if (message?.type === 'saveGlobalSettingsMinutes') {
		let minutes = Math.max(0, Math.floor(Number(message.intervalMin) || 0));
		await browser.storage.local.set({ [MFA_GLOBAL_INTERVAL_KEY]: minutes });
		await scheduleChecksFromSettings();
		return { ok: true, intervalMin: minutes };
	}
});
