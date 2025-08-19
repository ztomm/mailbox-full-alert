/* global browser */
/**
 * Mailbox Full Alert (quota warning) - MFA
 * - Per-account mailbox size (GB) and warning threshold (%)
 * - Local sum of all messages across folders
 * - Checks on startup and via browser.alarms (user-configurable; 0 disables)
 * - Toolbar badge shows percentage of the most critical account
 * - Tooltip shows only the account name
 * - Options page can trigger single-account checks
 */

/* ===========================
* Defaults & keys (constants)
* =========================== */
const MFA_DEFAULT_CHECK_INTERVAL_MIN = 360;     // default 6 hours
const MFA_DEFAULT_THRESHOLD_PCT = 80;      // default warning threshold
const MFA_NOTIFY_STATE_KEY_PREFIX = 'MFA_lastNotifiedPct_';
const MFA_GLOBAL_INTERVAL_KEY = 'MFA_globalIntervalMin';

/* ===========================
* Utils
* =========================== */

/** Format bytes to human readable string */
function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) return '–';
	let units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let n = bytes, i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	let fixed = n >= 100 ? 0 : n >= 10 ? 1 : 2;
	return `${n.toFixed(fixed)} ${units[i]}`;
}

/** Sum sizes of all messages in a folder (handles pagination) */
async function sumFolderMessagesSize(folder) {
	let total = 0;
	let page = await browser.messages.list(folder);
	while (true) {
		for (let msg of page.messages) {
			if (typeof msg.size === 'number') total += msg.size;
		}
		if (!page.id) break;
		page = await browser.messages.continueList(page.id);
	}
	return total;
}

/** Sum all folders of an account */
async function sumAccountBytes(accountId) {
	let account = await browser.accounts.get(accountId, true); // include subfolders
	if (!account || !account.rootFolder) return 0;

	let total = 0;
	async function walk(folder) {
		total += await sumFolderMessagesSize(folder);
		if (Array.isArray(folder.subFolders) && folder.subFolders.length) {
			for (let child of folder.subFolders) await walk(child);
		} else {
			let children = await browser.folders.getSubFolders(folder);
			for (let child of children) await walk(child);
		}
	}
	await walk(account.rootFolder);
	return total;
}

/* ===========================
* Storage helpers
* =========================== */

async function getPerAccountConfig() {
	let { perAccount = {} } = await browser.storage.local.get({ perAccount: {} });
	return perAccount; // { [id]: { active:boolean, limitBytes:number, thresholdPct:number } }
}

async function setPerAccountConfig(perAccount) {
	await browser.storage.local.set({ perAccount });
}

async function getGlobalIntervalMin() {
	let obj = await browser.storage.local.get({ [MFA_GLOBAL_INTERVAL_KEY]: MFA_DEFAULT_CHECK_INTERVAL_MIN });
	let val = obj[MFA_GLOBAL_INTERVAL_KEY];
	return Number.isFinite(val) ? val : MFA_DEFAULT_CHECK_INTERVAL_MIN;
}

async function setGlobalIntervalMin(minutes) {
	await browser.storage.local.set({ [MFA_GLOBAL_INTERVAL_KEY]: minutes });
}

/* ===========================
* Notifications & UI badge
* =========================== */

async function notify(account, used, limit, pctUsed, threshold) {
	let title = browser.i18n.getMessage('notifyTitle', account.name || account.id);
	let line1 = browser.i18n.getMessage('notifyLineUsed', [formatBytes(used), formatBytes(limit), pctUsed.toFixed(1)]);
	let line2 = browser.i18n.getMessage('notifyLineThreshold', [`${threshold}%`]);

	await browser.notifications.create(`quota-${account.id}-${Date.now()}`, {
		type: 'basic',
		iconUrl: 'icons/icon-96.png',
		title,
		message: `${line1}\n${line2}`
	});
}

/** Set toolbar badge + title */
async function setBadge(percent, accountName) {
	if (percent != null) {
		await browser.browserAction.setBadgeText({ text: `${percent}%` });
		try { await browser.browserAction.setBadgeBackgroundColor({ color: '#d93025' }); } catch { }
		await browser.browserAction.setTitle({ title: accountName || browser.i18n.getMessage('extShortName') || 'MFA' });
	} else {
		await browser.browserAction.setBadgeText({ text: '' });
		await browser.browserAction.setTitle({ title: browser.i18n.getMessage('extShortName') || 'MFA' });
	}
}

/* ===========================
* Core check
* =========================== */

async function checkAllAccounts({ forceNotify = false, onlyAccountId = null } = {}) {
	let accounts = await browser.accounts.list();
	let perAccount = await getPerAccountConfig();

	let topBadgeAccountName = null;
	let topBadgePercent = -1;

	for (let acc of accounts) {
		if (onlyAccountId && acc.id !== onlyAccountId) continue;

		let conf = perAccount[acc.id] || {};
		let active = conf.active !== false; // default active
		let limit = Number(conf.limitBytes || 0);
		let threshold = Number.isFinite(conf.thresholdPct) ? conf.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT;

		if (!active) continue;               // skip inactive
		if (!limit || limit <= 0) continue;  // skip if no mailbox size

		let used = 0;
		try { used = await sumAccountBytes(acc.id); }
		catch (e) { console.error('Summation failed for account', acc.id, e); continue; }

		let pctUsed = (used / limit) * 100;
		let key = `${MFA_NOTIFY_STATE_KEY_PREFIX}${acc.id}`;
		let st = await browser.storage.local.get({ [key]: 0 });
		let lastPct = st[key];
		let crossedUp = pctUsed >= threshold && lastPct < threshold;

		if (pctUsed >= threshold) {
			let floored = Math.floor(pctUsed);
			if (floored > topBadgePercent) {
				topBadgePercent = floored;
				topBadgeAccountName = acc.name || acc.id;
			}
		}

		if ((forceNotify && pctUsed >= threshold) || crossedUp) {
			await notify(acc, used, limit, pctUsed, threshold);
		}

		let storePct = Math.round(pctUsed * 10) / 10;
		await browser.storage.local.set({ [key]: storePct });
	}

	await setBadge(topBadgePercent >= 0 ? topBadgePercent : null, topBadgeAccountName);
}

/** Build a usage snapshot for the options page */
async function getAccountsUsageSnapshot() {
	let accounts = await browser.accounts.list();
	let perAccount = await getPerAccountConfig();
	let out = [];

	for (let acc of accounts) {
		let conf = perAccount[acc.id] || {};
		let active = conf.active !== false;
		let limit = Number(conf.limitBytes || 0);
		let threshold = Number.isFinite(conf.thresholdPct) ? conf.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT;

		let used = 0;
		if (limit > 0) {
			try { used = await sumAccountBytes(acc.id); }
			catch (e) { console.error('Summation failed for account', acc.id, e); }
		}
		let pctUsed = limit > 0 ? (used / limit) * 100 : 0;

		out.push({
			id: acc.id,
			name: acc.name || acc.id,
			active,
			limitBytes: limit,
			thresholdPct: threshold,
			usedBytes: used,
			pctUsed: pctUsed
		});
	}
	return out;
}

/* ===========================
* Scheduling
* =========================== */

async function scheduleChecksFromSettings() {
	try {
		let minutesRaw = await getGlobalIntervalMin();
		await browser.alarms.clear('quota-check');

		let minutes = Math.max(0, Math.floor(Number(minutesRaw) || 0));
		if (minutes === 0) return;

		let period = Math.max(1, minutes); // alarms require >= 1 minute
		await browser.alarms.create('quota-check', { periodInMinutes: period });
	} catch (e) {
		console.error('[MFA] Failed to schedule checks', e);
	}
}

/* ===========================
* Lifecycle & events
* =========================== */

browser.runtime.onInstalled.addListener(async () => {
	await scheduleChecksFromSettings();
	checkAllAccounts().catch(console.error);
});

browser.runtime.onStartup.addListener(async () => {
	await scheduleChecksFromSettings();
	checkAllAccounts().catch(console.error);
});

browser.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === 'quota-check') {
		// Always force notify on scheduled checks
		checkAllAccounts({ forceNotify: true }).catch(console.error);
	}
});

/** Toolbar click opens options page */
browser.browserAction.onClicked.addListener(() => {
	browser.runtime.openOptionsPage();
});

/* ===========================
* Messaging for options page
* =========================== */

browser.runtime.onMessage.addListener(async (msg) => {
	if (msg?.type === 'getAccountsState') {
		let accounts = await browser.accounts.list();
		let conf = await getPerAccountConfig();
		return accounts.map(a => ({
			id: a.id,
			name: a.name,
			active: conf[a.id]?.active !== false,
			limitBytes: conf[a.id]?.limitBytes || 0,
			thresholdPct: Number.isFinite(conf[a.id]?.thresholdPct) ? conf[a.id].thresholdPct : MFA_DEFAULT_THRESHOLD_PCT
		}));
	}

	if (msg?.type === 'getAccountsUsage') {
		let snap = await getAccountsUsageSnapshot();
		return snap;
	}

	if (msg?.type === 'saveAccountsConfig') {
		let nextPartial = msg.payload || {};
		let current = await getPerAccountConfig();
		let merged = { ...current, ...nextPartial };
		await setPerAccountConfig(merged);
		return { ok: true };
	}

	if (msg?.type === 'runCheckNow') {
		await checkAllAccounts({
			forceNotify: msg.force === true,
			onlyAccountId: msg.accountId || null
		});
		return { ok: true };
	}

	if (msg?.type === 'getGlobalSettings') {
		let intervalMin = await getGlobalIntervalMin();
		return { intervalMin };
	}

	if (msg?.type === 'saveGlobalSettingsMinutes') {
		let minutes = Math.max(0, Math.floor(Number(msg.intervalMin) || 0));
		await setGlobalIntervalMin(minutes);
		await scheduleChecksFromSettings();
		return { ok: true, intervalMin: minutes };
	}
});
