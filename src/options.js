/* global browser */

const MFA_DEFAULT_THRESHOLD_PCT = 80;
const MFA_DEFAULT_INTERVAL_MIN = 360;
const MFA_AUTOSAVE_DEBOUNCE_MS = 650;
const MFA_COMMON_LIMITS_GB = ['1', '2', '5', '10', '15', '50'];
const rowControllers = [];

const $ = (selector, root = document) => root.querySelector(selector);

function t(key, substitutions = []) {
	return browser.i18n.getMessage(key, substitutions) || key;
}

function localizeWithin(root) {
	root.querySelectorAll('[data-i18n]').forEach(element => {
		element.textContent = t(element.dataset.i18n);
	});
	root.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
		element.placeholder = t(element.dataset.i18nPlaceholder);
	});
	root.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
		element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
	});
}

function parseLocaleNumber(value) {
	let cleaned = String(value ?? '').trim().replace(',', '.');
	if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
	return Number(cleaned);
}

function toBytesGB(value) {
	let number = parseLocaleNumber(value);
	if (!Number.isFinite(number) || number <= 0) return NaN;
	return Math.round(number * 1024 ** 3);
}

function fromBytesToGB(bytes) {
	let value = Number(bytes || 0) / 1024 ** 3;
	if (!(value > 0)) return '';
	return value % 1 === 0 ? String(value) : String(Math.round(value * 10) / 10);
}

function formatBytes(bytes) {
	let value = Number(bytes) || 0;
	let unit = value >= 1024 ** 3 ? 'gigabyte' : 'megabyte';
	let divisor = unit === 'gigabyte' ? 1024 ** 3 : 1024 ** 2;
	try {
		return new Intl.NumberFormat(browser.i18n.getUILanguage(), {
			style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1
		}).format(value / divisor);
	} catch (error) {
		return `${(value / divisor).toFixed(1)} ${unit === 'gigabyte' ? 'GB' : 'MB'}`;
	}
}

function accountTypeText(type) {
	if (type === 'imap') return t('accountTypeImap');
	if (type === 'pop3') return t('accountTypePop');
	return t('accountTypeOther');
}

function intervalSelectToMinutes(value) {
	let values = { off: 0, '5m': 5, '30m': 30, '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440 };
	return values[value] ?? MFA_DEFAULT_INTERVAL_MIN;
}

function minutesToIntervalSelect(minutes) {
	let values = { 0: 'off', 5: '5m', 30: '30m', 60: '1h', 180: '3h', 360: '6h', 720: '12h', 1440: '24h' };
	return values[Math.max(0, Math.floor(Number(minutes) || 0))] || '6h';
}

function setFeedback(key, kind = '', substitutions = []) {
	let feedback = $('#feedback');
	if (!feedback) return;
	$('.feedback-message', feedback).textContent = key ? t(key, substitutions) : '';
	feedback.className = `feedback ${kind}`.trim();
	feedback.dataset.messageKey = key || '';
	feedback.hidden = !key;
	feedback.setAttribute('role', kind === 'error' ? 'alert' : 'status');
	feedback.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

function clearInvalidMailboxSizeFeedback() {
	if ($('#feedback')?.dataset.messageKey === 'invalidMailboxSize') setFeedback('');
}

function applyStatusToRow(row, account) {
	let status = $('.status', row);
	let detail = $('.status-detail', row);
	status.className = 'status';
	detail.textContent = '';

	if (!account.active) {
		status.textContent = t('statusInactive');
		return;
	}
	if (!(account.limitBytes > 0)) {
		status.textContent = t('statusNeedsSize');
		status.classList.add('setup');
		return;
	}
	if (account.error) {
		status.textContent = t('statusError');
		status.classList.add('error');
		return;
	}
	if (!account.checkedAt) {
		status.textContent = t('statusNotChecked');
		return;
	}

	let percent = Math.round(Number(account.pctUsed || 0));
	let free = Math.max(0, Number(account.limitBytes) - Number(account.usedBytes || 0));
	status.textContent = `${percent}%`;
	detail.textContent = `${formatBytes(account.usedBytes)} ${t('labelUsed')}, ${formatBytes(free)} ${t('labelFreeSpace')}`;
	if (Number(account.pctUsed || 0) >= Number(account.thresholdPct || MFA_DEFAULT_THRESHOLD_PCT)) {
		status.classList.add('error');
	} else {
		status.classList.add('ok');
	}
}

function updateRowsFromSnapshot(snapshot) {
	let byId = Object.fromEntries((snapshot || []).map(account => [account.id, account]));
	for (let controller of rowControllers) {
		let account = byId[controller.accountId];
		if (!account) continue;
		controller.account = account;
		applyStatusToRow(controller.row, account);
	}
}

function createRowController(account) {
	let template = $('#rowTemplate');
	let fragment = document.importNode(template.content, true);
	localizeWithin(fragment);
	let row = $('.account-row', fragment);
	let active = $('.active', row);
	let name = $('.account-name', row);
	let type = $('.account-type', row);
	let limitChoice = $('.limit-choice', row);
	let limitCustom = $('.limit-custom', row);
	let threshold = $('.threshold', row);
	let checkButton = $('.check-row', row);
	let timer = null;
	let saveQueue = Promise.resolve(true);
	let saveRevision = 0;
	let checking = false;
	let configReady = true;

	name.textContent = account.name;
	type.textContent = accountTypeText(account.type);
	if (account.type === 'pop3') type.title = t('popLimited');
	else if (account.type !== 'imap') type.title = t('otherLimited');
	active.checked = account.active !== false;
	active.setAttribute('aria-label', t('ariaActive', account.name));
	let initialLimit = fromBytesToGB(account.limitBytes);
	if (MFA_COMMON_LIMITS_GB.includes(initialLimit)) {
		limitChoice.value = initialLimit;
	} else if (initialLimit) {
		limitChoice.value = 'custom';
		limitCustom.value = initialLimit;
		limitCustom.hidden = false;
	}
	limitChoice.setAttribute('aria-label', t('ariaLimit', account.name));
	limitCustom.setAttribute('aria-label', t('ariaLimit', account.name));
	threshold.value = String([50, 60, 70, 80, 90, 95].includes(account.thresholdPct) ? account.thresholdPct : MFA_DEFAULT_THRESHOLD_PCT);
	threshold.setAttribute('aria-label', t('ariaThreshold', account.name));
	checkButton.setAttribute('aria-label', t('ariaCheckAccount', account.name));
	applyStatusToRow(row, account);

	function rawLimitValue() {
		return limitChoice.value === 'custom' ? limitCustom.value.trim() : limitChoice.value;
	}

	function validLimitOrEmpty() {
		let raw = rawLimitValue();
		return limitChoice.value === '' || Number.isFinite(toBytesGB(raw));
	}

	function canCheck() {
		return configReady && active.checked && Number.isFinite(toBytesGB(rawLimitValue()));
	}

	function updateCheckButtonState() {
		checkButton.disabled = checking || !canCheck();
	}

	function markConfigDirty() {
		saveRevision += 1;
		configReady = false;
		updateCheckButtonState();
	}

	function payload() {
		let raw = rawLimitValue();
		return {
			[account.id]: {
				active: active.checked,
				limitBytes: raw === '' ? 0 : toBytesGB(raw),
				thresholdPct: Number(threshold.value)
			}
		};
	}

	async function save() {
		if (!validLimitOrEmpty()) {
			markConfigDirty();
			limitCustom.classList.add('invalid');
			setFeedback('invalidMailboxSize', 'error');
			return false;
		}
		limitCustom.classList.remove('invalid');
		clearInvalidMailboxSizeFeedback();
		let revision = ++saveRevision;
		let nextPayload = payload();
		configReady = false;
		updateCheckButtonState();
		saveQueue = saveQueue.then(async () => {
			try {
				let result = await browser.runtime.sendMessage({ type: 'saveAccountsConfig', payload: nextPayload });
				if (revision === saveRevision) {
					updateRowsFromSnapshot(result.usage);
					configReady = true;
					updateCheckButtonState();
				}
				return true;
			} catch (error) {
				console.error(error);
				if (revision === saveRevision) {
					configReady = false;
					updateCheckButtonState();
					setFeedback('saveFailed', 'error');
				}
				return false;
			}
		});
		return saveQueue;
	}

	function scheduleSave() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			save().catch(console.error);
		}, MFA_AUTOSAVE_DEBOUNCE_MS);
	}

	async function flush() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
			return save();
		}
		return (await saveQueue) && validLimitOrEmpty();
	}

	updateCheckButtonState();
	active.addEventListener('change', () => {
		markConfigDirty();
		save().catch(console.error);
	});
	threshold.addEventListener('change', () => {
		markConfigDirty();
		save().catch(console.error);
	});
	limitChoice.addEventListener('change', () => {
		limitCustom.hidden = limitChoice.value !== 'custom';
		limitCustom.classList.remove('invalid');
		markConfigDirty();
		if (limitChoice.value === 'custom') {
			limitCustom.focus();
			if (!limitCustom.value.trim()) return;
		}
		save().catch(console.error);
	});
	limitCustom.addEventListener('input', () => {
		let valid = validLimitOrEmpty();
		limitCustom.classList.toggle('invalid', !valid);
		markConfigDirty();
		if (valid) {
			clearInvalidMailboxSizeFeedback();
			scheduleSave();
		}
		else if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	});
	limitCustom.addEventListener('change', () => save().catch(console.error));
	checkButton.addEventListener('click', async () => {
		if (!(await flush())) return;
		if (!canCheck()) {
			updateCheckButtonState();
			return;
		}
		checking = true;
		checkButton.classList.add('checking');
		updateCheckButtonState();
		checkButton.textContent = t('btnChecking');
		setFeedback('checkingAccount', '', [account.name]);
		try {
			let result = await browser.runtime.sendMessage({ type: 'runCheckNow', accountId: account.id });
			updateRowsFromSnapshot(result.usage);
			let checkedAccount = result.usage.find(item => item.id === account.id);
			setFeedback(checkedAccount?.error ? 'checkFailed' : 'checkComplete', checkedAccount?.error ? 'error' : 'success');
		} catch (error) {
			console.error(error);
			setFeedback('checkFailed', 'error');
		} finally {
			checking = false;
			checkButton.classList.remove('checking');
			checkButton.textContent = t('btnCheck');
			updateCheckButtonState();
		}
	});

	return { accountId: account.id, account, row, fragment, flush };
}

function getATNLocale() {
	let locale = browser.i18n.getUILanguage?.() || browser.i18n.getMessage('@@ui_locale') || 'en-US';
	return String(locale).replace('_', '-');
}

async function load() {
	localizeWithin(document);
	document.documentElement.lang = browser.i18n.getUILanguage?.() || 'en';
	$('#addonLink').href = `https://services.addons.thunderbird.net/${getATNLocale()}/thunderbird/addon/mailbox-full-alert/`;

	let [globalSettings, accounts] = await Promise.all([
		browser.runtime.sendMessage({ type: 'getGlobalSettings' }),
		browser.runtime.sendMessage({ type: 'getAccountsState' })
	]);

	let onboarding = $('#onboarding');
	onboarding.hidden = globalSettings.showOnboarding !== true;
	$('#dismissOnboarding').addEventListener('click', async () => {
		await browser.runtime.sendMessage({ type: 'dismissOnboarding' });
		onboarding.hidden = true;
	});

	let interval = $('#intervalHours');
	interval.value = minutesToIntervalSelect(globalSettings.intervalMin);
	interval.addEventListener('change', async () => {
		try {
			await browser.runtime.sendMessage({
				type: 'saveGlobalSettingsMinutes',
				intervalMin: intervalSelectToMinutes(interval.value)
			});
			setFeedback('settingsSaved', 'success');
		} catch (error) {
			console.error(error);
			setFeedback('saveFailed', 'error');
		}
	});

	let rows = $('#rows');
	for (let account of accounts) {
		let controller = createRowController(account);
		rowControllers.push(controller);
		rows.appendChild(controller.fragment);
	}

	window.addEventListener('pagehide', () => {
		for (let controller of rowControllers) controller.flush().catch(console.error);
	});
}

document.addEventListener('DOMContentLoaded', () => load().catch(error => {
	console.error(error);
	setFeedback('loadFailed', 'error');
}));
