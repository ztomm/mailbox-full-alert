# Mailbox Full Alert

![Icon](src/icons/icon-256.png)

**Measure mailbox usage in Thunderbird and get warned before your email storage is full.**

Mailbox Full Alert is intended for email providers that do not report a usable server-side mailbox limit to Thunderbird. You enter the total mailbox capacity supplied by the provider once. The add-on then measures the combined size of the messages Thunderbird knows for that account and compares it with your selected warning level.

## How it works

1. Find the total mailbox capacity in your provider's customer portal, help pages or webmail.
2. Enter that size for the account in the add-on settings.
3. Choose a warning level and run the first check.

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

Thanks to [Topoldo](https://github.com/topoldo) for improving the Italian translation.
