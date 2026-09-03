# Mailbox Full Alert

![Icon](src/icons/icon-256.png)

**Measure mailbox usage in Thunderbird and get warned before your email storage is full.**

Thunderbird does not know your mailbox size. Enter it once and Mailbox Full Alert automatically measures your email storage usage and warns you before the mailbox is full.

Requires **Thunderbird 140.0 ESR or later**.

## How it works

1. Choose an automatic check interval.
2. Select the mailboxes you want to monitor.
3. Enter the mailbox size and run the first check.

The add-on checks on Thunderbird startup, at a configurable interval, or on demand. A red percentage remains on the toolbar button until a later check finds that usage is below the warning level. A yellow `!` means that an active account still needs a mailbox size.

## IMAP and POP

Mailbox Full Alert works best with **fully synchronized IMAP accounts**. When all IMAP folders are synchronized, the messages known to Thunderbird correspond to the messages in the server mailbox.

POP accounts are only suitable to a limited extent because messages that remain solely on the server cannot be included in the measurement.

## Features

- Per-account mailbox capacity and warning level
- Guided first-time setup
- Toolbar badge for warnings and incomplete setup
- Manual check for each account
- Configurable automatic check interval
- Settings preserved across add-on updates
- Multi-language and screen-reader-friendly interface

All processing stays inside Thunderbird. The add-on does not send message contents, account information or usage data to an external service.

Download the add-on from [Thunderbird Add-ons](https://addons.thunderbird.net/thunderbird/addon/mailbox-full-alert/).

Thanks to [Topoldo](https://github.com/topoldo) for contributions to the Italian localization.
