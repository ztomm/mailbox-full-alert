/* global browser */
/**
 * Options UI logic for MFA (7-column layout)
 * Columns: Active | Account | Usage% | Detail(used/free/time) | Mailbox GB | Threshold | Update
 * - Percent is bold & black; turns red when over threshold
 * - Account name stays black; turns red+bold only when over threshold
 * - Columns 3 and 4 are empty when inactive or limit <= 0 (no placeholders)
 */

const MFA_DEFAULT_THRESHOLD_PCT = 80;
const MFA_DEFAULT_INTERVAL_MIN = 360; // 6h fallback
const MFA_AUTOSAVE_DEBOUNCE_MS = 700;

const $ = (sel, el = document) => el.querySelector(sel);

function t(key, subs = []) {
	return browser.i18n.getMessage(key, subs) || key;
}

function localizeWithin(root) {
	root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
	root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
}

function localizeDocument() { localizeWithin(document); }

/* ===== Add-on page locale URL ===== */
function getATNLocaleFromUI() {
	let ui = '';
	try {
		if (browser?.i18n?.getUILanguage) ui = browser.i18n.getUILanguage() || '';
	} catch (e) { /* ignore */ }

	// Fallback used by many WebExtensions
	if (!ui) {
		try { ui = browser.i18n.getMessage('@@ui_locale') || ''; } catch (e) { /* ignore */ }
	}

	ui = String(ui || '').trim().replace('_', '-');
	if (!ui) return 'en-US';

	let parts = ui.split('-').filter(Boolean);
	let lang = (parts[0] || 'en').toLowerCase();

	// ATN commonly uses en-US rather than just "en"
	if (lang === 'en' && parts.length === 1) return 'en-US';

	// Find a region subtag (2 letters or 3 digits) and collapse scripts like zh-Hans-CN -> zh-CN
	let region = null;
	for (let i = 1; i < parts.length; i++) {
		let p = parts[i];
		if (/^[a-zA-Z]{2}$/.test(p) || /^[0-9]{3}$/.test(p)) {
			region = p.toUpperCase();
			break;
		}
	}

	return region ? `${lang}-${region}` : lang;
}

/* ===== Numbers & sizes ===== */
function parseLocaleNumber(str) {
	if (typeof str !== 'string') return Number(str);
	let cleaned = str.trim().replace(',', '.');
	if (!/^[+]?\d*(\.\d+)?$/.test(cleaned)) return NaN;
	return Number(cleaned);
}

function toBytesGB(valStr) {
	let n = parseLocaleNumber(valStr);
	if (!Number.isFinite(n) || n <= 0) return NaN;
	return Math.round(n * 1024 * 1024 * 1024);
}

function fromBytesToGBString(bytes) {
	if (!bytes || !Number.isFinite(bytes)) return '';
	let gb = bytes / (1024 ** 3);
	return (gb % 1 === 0) ? String(gb) : gb.toFixed(1);
}

function humanSize(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
	let gb = bytes / (1024 ** 3);
	if (gb >= 1) return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
	let mb = bytes / (1024 ** 2);
	return mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
}

function formatPct(n) {
	return `${Math.round(n)}%`;
}

function formatTimeShort() {
	try {
		let s = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		let suffix = browser.i18n.getMessage('labelClockSuffix');
		return suffix && suffix !== 'labelClockSuffix' ? `${s}${suffix}` : s;
	} catch {
		return '';
	}
}

/* ===== Helper: check visibility ===== */
function isHidden(el) {
	return !el || el.offsetParent === null;
}

/* ===== Paint Usage columns (3 & 4) ===== */
function paintUsageColumns(rowEl, status) {
  let active = rowEl.querySelector('.activeToggle')?.checked;
  let limit  = Number(status?.limitBytes || 0);
  let used   = Number(status?.usedBytes || 0);
  let pct    = limit > 0 ? Number(status?.pctUsed || (used / limit) * 100) : 0;
  let thr    = Number(status?.thresholdPct || MFA_DEFAULT_THRESHOLD_PCT);

  let nameEl   = rowEl.querySelector('.name');
  let pctEl    = rowEl.querySelector('.usage-pt .pct');   // column 3
  let detailEl = rowEl.querySelector('.usage-detail');    // column 4

  // Reset visuals first
  if (nameEl) { nameEl.style.color = ''; nameEl.style.fontWeight = ''; }
  if (pctEl)  { pctEl.style.color = ''; pctEl.style.fontWeight = '700'; } // bold black by default

  // Empty state for columns 3 & 4 when inactive or no limit
  if (!active || !(limit > 0)) {
    if (pctEl)    pctEl.textContent = '';
    if (detailEl) detailEl.textContent = '';
    return;
  }

  let free = Math.max(0, limit - used);

  // Fill usage% (col 3)
  if (pctEl) {
    if (isHidden(detailEl)) {
      // Compact mode (<1600px): show % and free in col 3
      pctEl.innerHTML = `${formatPct(pct)} <br>${humanSize(free)} ${t('labelFreeSpace')}`;
    } else {
      // Normal mode: only % in col 3
      pctEl.innerHTML = formatPct(pct);
    }
  }

  // Detail (col 4)
  if (detailEl && !isHidden(detailEl)) {
    let timeStr = formatTimeShort();
    let detailTxt = `${humanSize(used)} ${t('labelUsed')}, ${humanSize(free)} ${t('labelFreeSpace')}${timeStr ? ' - ' + timeStr : ''}`;
    detailEl.textContent = detailTxt;
  }

  // Over threshold: name red+bold; percent red
  if (pct >= thr) {
    if (nameEl) { nameEl.style.color = '#d93025'; nameEl.style.fontWeight = '600'; }
    if (pctEl)  { pctEl.style.color = '#d93025'; }
  }
}

/* ===== Interval mapping ===== */
function intervalSelectToMinutes(val) {
	let map = { off: 0, '5m': 5, '30m': 30, '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440 };
	return map[val] ?? MFA_DEFAULT_INTERVAL_MIN;
}

function minutesToIntervalSelect(mins) {
	let m = Math.max(0, Math.floor(Number(mins) || 0));
	if (m === 0) return 'off';
	let map = { 5: '5m', 30: '30m', 60: '1h', 180: '3h', 360: '6h', 720: '12h', 1440: '24h' };
	return map[m] || '6h';
}

/* ===== Page boot ===== */
async function load() {
	localizeDocument();

	// set localized add-on page URL
	let addonLink = document.getElementById('addonLink');
	if (addonLink) {
		let loc = getATNLocaleFromUI();
		addonLink.href = `https://services.addons.thunderbird.net/${loc}/thunderbird/addon/mailbox-full-alert/`;
	}

	// Collect per-row flushers to try saving before the options window closes.
	const flushPendingUpdates = [];

	// Bottom interval selector (auto-save)
	let selInterval = $('#intervalHours');
	if (selInterval) {
		try {
			let gs = await browser.runtime.sendMessage({ type: 'getGlobalSettings' });
			selInterval.value = minutesToIntervalSelect(gs?.intervalMin);
		} catch (e) {
			console.error(e);
			selInterval.value = minutesToIntervalSelect(MFA_DEFAULT_INTERVAL_MIN);
		}
		selInterval.addEventListener('change', async () => {
			let minutes = intervalSelectToMinutes(selInterval.value);
			try {
				await browser.runtime.sendMessage({ type: 'saveGlobalSettingsMinutes', intervalMin: minutes });
			} catch (e) { console.error(e); }
		});
	}

	// Accounts table rendering
	let rowsEl = $('#rows');
	if (!rowsEl) return;
	rowsEl.innerHTML = '';

	let accounts = [];
	try {
		accounts = await browser.runtime.sendMessage({ type: 'getAccountsState' });
	} catch (e) {
		console.error('Failed to get accounts state', e);
	}

	for (let a of accounts) {
		let tplNode = $('#row-tpl');
		if (!tplNode) break;

		let frag = document.importNode(tplNode.content, true);
		localizeWithin(frag);

		let rowEl = frag.querySelector('.grid-row');
		if (!rowEl) continue;
		rowEl.dataset.accountId = a.id;

		let activeToggle = rowEl.querySelector('.activeToggle');
		let nameEl = rowEl.querySelector('.name');
		let limitInput = rowEl.querySelector('.limit');
		let thresholdSelect = rowEl.querySelector('.threshold');
		let btn = rowEl.querySelector('.saveAndCheckRow');

		if (activeToggle) activeToggle.checked = a.active !== false;
		if (nameEl) nameEl.textContent = a.name || a.id;
		if (limitInput) limitInput.value = fromBytesToGBString(a.limitBytes);

		let pct = Number.isFinite(a.thresholdPct) ? a.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT;
		if (thresholdSelect) thresholdSelect.value = String([50, 60, 70, 80, 90, 95].includes(pct) ? pct : MFA_DEFAULT_THRESHOLD_PCT);

		// Keep last successfully saved values, so we don't overwrite storage with 0 when the user
		// temporarily types an invalid number like "1.".
		let savedLimitBytes = Number(a.limitBytes || 0);
		let savedThresholdPct = Number(thresholdSelect?.value ?? MFA_DEFAULT_THRESHOLD_PCT);
		let savedActive = !!activeToggle?.checked;

		let autosaveTimer = null;
		let inFlight = false;
		let pending = false;

		function setButtonBusy(on) {
			if (!btn) return;
			btn.disabled = !!on;
			btn.textContent = on ? t('btnUpdating') : t('btnUpdate');
		}

		function computeLimitBytesForSave() {
			let raw = (limitInput?.value ?? '').trim();
			if (raw === '') return 0;

			let bytes = toBytesGB(raw);
			if (Number.isFinite(bytes)) return bytes;

			// If invalid but non-empty, do not clobber the stored limit.
			return savedLimitBytes;
		}

		function isLimitValueValidOrEmpty() {
			let raw = (limitInput?.value ?? '').trim();
			if (raw === '') return true;
			return Number.isFinite(toBytesGB(raw));
		}

		async function saveAndCheckRow() {
			if (inFlight) { pending = true; return; }

			inFlight = true;
			pending = false;

			let limitBytes = computeLimitBytesForSave();
			let pctVal = Number(thresholdSelect?.value ?? MFA_DEFAULT_THRESHOLD_PCT);
			let isActive = !!activeToggle?.checked;

			let payload = {
				[rowEl.dataset.accountId]: {
					active: isActive,
					limitBytes,
					thresholdPct: pctVal
				}
			};

			setButtonBusy(true);

			try {
				await browser.runtime.sendMessage({ type: 'saveAccountsConfig', payload });
				await browser.runtime.sendMessage({ type: 'runCheckNow', force: true, accountId: rowEl.dataset.accountId });

				// Update "last saved" values only after successful save
				savedLimitBytes = limitBytes;
				savedThresholdPct = pctVal;
				savedActive = isActive;

				// Repaint usage columns with fresh snapshot (includes time)
				let usage = await browser.runtime.sendMessage({ type: 'getAccountsUsage' });
				let one = usage.find(u => u.id === rowEl.dataset.accountId);
				if (one) paintUsageColumns(rowEl, one);
			} catch (e) {
				console.error(e);
			} finally {
				setButtonBusy(false);
				inFlight = false;

				if (pending) {
					// Run one more time to apply the latest state if changes happened during the in-flight save.
					saveAndCheckRow().catch(console.error);
				}
			}
		}

		function triggerImmediateSaveAndCheck() {
			if (autosaveTimer) clearTimeout(autosaveTimer);
			autosaveTimer = null;
			saveAndCheckRow().catch(console.error);
		}

		function scheduleSaveAndCheck(delayMs) {
			if (autosaveTimer) clearTimeout(autosaveTimer);
			autosaveTimer = setTimeout(() => {
				autosaveTimer = null;
				saveAndCheckRow().catch(console.error);
			}, delayMs);
		}

		// Allow pagehide/visibilitychange flush (best-effort)
		flushPendingUpdates.push(() => {
			if (autosaveTimer) {
				clearTimeout(autosaveTimer);
				autosaveTimer = null;
				// best-effort; may not finish before the page closes
				saveAndCheckRow().catch(console.error);
			}
		});

		// Activation toggle: auto save+check; also clear usage immediately when turning off
		activeToggle?.addEventListener('change', () => {
			if (!activeToggle.checked) {
				// Clear usage columns and reset styles immediately
				paintUsageColumns(rowEl, { limitBytes: 0, usedBytes: 0, thresholdPct: savedThresholdPct || MFA_DEFAULT_THRESHOLD_PCT });
			}
			triggerImmediateSaveAndCheck();
		});

		// Threshold change: auto save+check immediately
		thresholdSelect?.addEventListener('change', () => {
			triggerImmediateSaveAndCheck();
		});

		// GB validation
		let handleGB = () => {
			if (!limitInput) return;
			if (limitInput.value.includes(',')) limitInput.value = limitInput.value.replace(',', '.');
			let bytes = toBytesGB(limitInput.value);
			let valid = Number.isFinite(bytes) || limitInput.value === '';
			limitInput.classList.toggle('invalid', !valid && limitInput.value !== '');
		};
		limitInput?.addEventListener('input', handleGB);
		handleGB();

		// Mailbox size: auto save+check
		// - input fires for typing AND for step-buttons (step="0.1")
		// - keyup is added as extra safety for some edge cases
		const onLimitEdited = () => {
			handleGB();

			// If cleared, save immediately (limit becomes 0 => usage columns should be empty)
			let raw = (limitInput?.value ?? '').trim();
			if (raw === '') {
				paintUsageColumns(rowEl, { limitBytes: 0, usedBytes: 0, thresholdPct: Number(thresholdSelect?.value ?? MFA_DEFAULT_THRESHOLD_PCT) });
				triggerImmediateSaveAndCheck();
				return;
			}

			// If invalid (e.g. "1."), do not schedule an update yet.
			if (!isLimitValueValidOrEmpty()) {
				if (autosaveTimer) clearTimeout(autosaveTimer);
				autosaveTimer = null;
				return;
			}

			// Valid number: debounce to avoid heavy checks on every keystroke
			scheduleSaveAndCheck(MFA_AUTOSAVE_DEBOUNCE_MS);
		};

		limitInput?.addEventListener('input', onLimitEdited);
		limitInput?.addEventListener('keyup', onLimitEdited);
		// If blur/change happens, apply immediately
		limitInput?.addEventListener('change', () => {
			if (isLimitValueValidOrEmpty()) triggerImmediateSaveAndCheck();
		});

		// Update button still works (now calls the shared logic)
		btn?.addEventListener('click', async () => {
			triggerImmediateSaveAndCheck();
		});

		rowsEl.appendChild(frag);
	}

	// Try to flush any pending row updates when the options page is closed/hidden
	const flushAll = () => {
		for (let fn of flushPendingUpdates) {
			try { fn(); } catch (e) { console.error(e); }
		}
	};
	window.addEventListener('pagehide', flushAll);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushAll();
	});

	// Initial snapshot: paint all rows
	try {
		let usage = await browser.runtime.sendMessage({ type: 'getAccountsUsage' });
		let byId = Object.fromEntries(usage.map(u => [u.id, u]));
		document.querySelectorAll('.grid-row').forEach(row => {
			let id = row.dataset.accountId;
			if (byId[id]) paintUsageColumns(row, byId[id]);
			else paintUsageColumns(row, { limitBytes: 0, usedBytes: 0, thresholdPct: MFA_DEFAULT_THRESHOLD_PCT });
		});
	} catch (e) {
		console.error(e);
	}
}

document.addEventListener('DOMContentLoaded', () => {
	load().catch(console.error);
});
