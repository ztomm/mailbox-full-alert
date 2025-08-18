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

const $ = (sel, el = document) => el.querySelector(sel);

function t(key, subs = []) {
	return browser.i18n.getMessage(key, subs) || key;
}

function localizeWithin(root) {
	root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
	root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
}

function localizeDocument() { localizeWithin(document); }

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

		// Activation toggle: repaint on change
		activeToggle?.addEventListener('change', () => {
			if (!activeToggle.checked) {
				// Clear usage columns and reset styles
				paintUsageColumns(rowEl, { limitBytes: 0, usedBytes: 0, thresholdPct: MFA_DEFAULT_THRESHOLD_PCT });
			} else {
				browser.runtime.sendMessage({ type: 'getAccountsUsage' })
					.then(usage => {
						let one = usage.find(u => u.id === rowEl.dataset.accountId);
						if (one) paintUsageColumns(rowEl, one);
					})
					.catch(console.error);
			}
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

		// Update (save & check this account)
		btn?.addEventListener('click', async () => {
			let bytes = toBytesGB(limitInput?.value ?? '');
			let limitBytes = Number.isFinite(bytes) ? bytes : 0;
			let pctVal = Number(thresholdSelect?.value ?? MFA_DEFAULT_THRESHOLD_PCT);

			let payload = {
				[rowEl.dataset.accountId]: {
					active: !!activeToggle?.checked,
					limitBytes,
					thresholdPct: pctVal
				}
			};

			if (btn) { btn.textContent = t('btnUpdating'); btn.disabled = true; }
			try {
				await browser.runtime.sendMessage({ type: 'saveAccountsConfig', payload });
				await browser.runtime.sendMessage({ type: 'runCheckNow', force: true, accountId: rowEl.dataset.accountId });

				// Repaint usage columns with fresh snapshot (includes time)
				let usage = await browser.runtime.sendMessage({ type: 'getAccountsUsage' });
				let one = usage.find(u => u.id === rowEl.dataset.accountId);
				if (one) paintUsageColumns(rowEl, one);
			} catch (e) {
				console.error(e);
			} finally {
				if (btn) { btn.textContent = t('btnUpdate'); btn.disabled = false; }
			}
		});

		rowsEl.appendChild(frag);
	}

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
