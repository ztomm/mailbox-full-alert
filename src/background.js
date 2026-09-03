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

async function sumAccountBytes(accountId) {
	let total = 0;
	let page = await browser.messages.query({ accountId });
	while (page) {
		for (let message of page.messages) total += Number(message.size || 0);
		page = page.id ? await browser.messages.continueList(page.id) : null;
	}
	return total;
}

async function getAccountData() {
	let stored = await browser.storage.local.get({ perAccount: {}, [MFA_ACCOUNT_STATUS_KEY]: {} });
	return {
		perAccount: stored.perAccount || {},
		statuses: stored[MFA_ACCOUNT_STATUS_KEY] || {}
	};
}

async function getGlobalIntervalMin() {
	let result = await browser.storage.local.get({ [MFA_GLOBAL_INTERVAL_KEY]: MFA_DEFAULT_CHECK_INTERVAL_MIN });
	let value = result[MFA_GLOBAL_INTERVAL_KEY];
	return Number.isFinite(value) ? value : MFA_DEFAULT_CHECK_INTERVAL_MIN;
}

function notificationId(accountId) {
	return `${MFA_NOTIFICATION_ID_PREFIX}${accountId}`;
}

function getAccountConfig(account, perAccount) {
	let stored = perAccount[account.id] || {};
	return {
		active: typeof stored.active === 'boolean' ? stored.active : account.type === 'imap',
		limitBytes: Math.max(0, Number(stored.limitBytes) || 0),
		thresholdPct: Number.isFinite(stored.thresholdPct) ? stored.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT
	};
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
	let [usedText, limitText] = await Promise.all([
		browser.messengerUtilities.formatFileSize(used),
		browser.messengerUtilities.formatFileSize(limit)
	]);
	let line1 = browser.i18n.getMessage('notifyLineUsed', [
		usedText, limitText, pctUsed.toFixed(1)
	]);
	let line2 = browser.i18n.getMessage('notifyLineThreshold', [`${threshold}%`]);
	await browser.notifications.create(notificationId(account.id), {
		type: 'basic', iconUrl: 'icons/icon-96.png', title,
		message: `${line1}\n${line2}`
	});
}

async function updateBadge(accounts, perAccount, statuses) {
	let top = null;
	let incompleteCount = 0;
	for (let account of accounts) {
		let { active, limitBytes, thresholdPct } = getAccountConfig(account, perAccount);
		if (!active) continue;
		if (!(limitBytes > 0)) {
			incompleteCount += 1;
			continue;
		}
		let status = statuses[account.id];
		if (status && Number(status.pctUsed) >= thresholdPct) {
			let candidate = { account, percent: Math.floor(Number(status.pctUsed)) };
			if (!top || candidate.percent > top.percent) top = candidate;
		}
	}

	if (top) {
		let badgeText = top.percent > 999 ? '999+' : `${top.percent}%`;
		await browser.browserAction.setBadgeText({ text: badgeText });
		await browser.browserAction.setBadgeBackgroundColor({ color: '#c62828' });
		await browser.browserAction.setTitle({ title: top.account.name || top.account.id });
		return;
	}

	if (incompleteCount) {
		await browser.browserAction.setBadgeText({ text: '!' });
		await browser.browserAction.setBadgeBackgroundColor({ color: '#e6a700' });
		await browser.browserAction.setTitle({
			title: browser.i18n.getMessage('badgeSetupTitle') || 'Setup required'
		});
		return;
	}

	await browser.browserAction.setBadgeText({ text: '' });
	await browser.browserAction.setTitle({ title: browser.i18n.getMessage('extShortName') || 'MFA' });
}

function buildUsageSnapshot(accounts, perAccount, statuses) {
	return accounts.map(account => {
		let config = getAccountConfig(account, perAccount);
		let status = statuses[account.id] || {};
		return {
			id: account.id,
			name: account.name || account.id,
			type: account.type || '',
			active: config.active,
			limitBytes: config.limitBytes,
			thresholdPct: config.thresholdPct,
			usedBytes: Number(status.usedBytes || 0),
			pctUsed: Number(status.pctUsed || 0),
			checkedAt: Number(status.checkedAt || 0),
			error: status.error || ''
		};
	});
}

async function performCheck({ onlyAccountId = null } = {}) {
	let accounts = await browser.accounts.list();
	let { perAccount, statuses } = await getAccountData();
	let notifyKeys = accounts.map(account => `${MFA_NOTIFY_STATE_KEY_PREFIX}${account.id}`);
	let notifyState = await browser.storage.local.get(notifyKeys);
	let notifyUpdates = {};
	let existingIds = new Set(accounts.map(account => account.id));
	for (let accountId of Object.keys(statuses)) {
		if (!existingIds.has(accountId)) delete statuses[accountId];
	}

	for (let account of accounts) {
		if (onlyAccountId && account.id !== onlyAccountId) continue;
		let { active, limitBytes, thresholdPct } = getAccountConfig(account, perAccount);
		let notifyKey = `${MFA_NOTIFY_STATE_KEY_PREFIX}${account.id}`;

		if (!active || !(limitBytes > 0)) {
			delete statuses[account.id];
			await clearNotification(account.id);
			notifyUpdates[notifyKey] = 0;
			continue;
		}

		try {
			let used = await sumAccountBytes(account.id);
			let pctUsed = (used / limitBytes) * 100;
			let lastPct = Number(notifyState[notifyKey] || 0);
			let crossedThreshold = pctUsed >= thresholdPct && lastPct < thresholdPct;
			if (pctUsed < thresholdPct) await clearNotification(account.id);
			if (crossedThreshold) await showNotification(account, used, limitBytes, pctUsed, thresholdPct);
			statuses[account.id] = {
				usedBytes: used,
				pctUsed: Math.round(pctUsed * 10) / 10,
				checkedAt: Date.now(), error: ''
			};
			notifyUpdates[notifyKey] = statuses[account.id].pctUsed;
		} catch (error) {
			console.error('[MFA] Check failed for account', account.id, error);
			statuses[account.id] = {
				...(statuses[account.id] || {}),
				error: String(error?.message || error)
			};
		}
	}

	await browser.storage.local.set({ ...notifyUpdates, [MFA_ACCOUNT_STATUS_KEY]: statuses });
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
	let { perAccount: current, statuses } = await getAccountData();
	let storageUpdates = { perAccount: current, [MFA_ACCOUNT_STATUS_KEY]: statuses };
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
			storageUpdates[`${MFA_NOTIFY_STATE_KEY_PREFIX}${accountId}`] = 0;
		}
	}
	await browser.storage.local.set(storageUpdates);
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
		let [accounts, accountData] = await Promise.all([browser.accounts.list(), getAccountData()]);
		return buildUsageSnapshot(accounts, accountData.perAccount, accountData.statuses);
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
