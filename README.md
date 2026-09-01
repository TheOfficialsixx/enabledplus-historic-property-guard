# Enabled+ Historic Property Guard

A small, read-only Tampermonkey helper that identifies Enabled+ leads needing a historic-property review and directs the agent to the appropriate official checker.

## Install

1. Install the Tampermonkey browser extension.
2. Open the [userscript installation link](https://raw.githubusercontent.com/TheOfficialsixx/enabledplus-historic-property-guard/main/enabledplus-historic-guard.user.js).
3. Approve the installation.
4. Refresh an Enabled+ lead page.

## What triggers it

The draggable panel stays hidden unless the lead contains reasonable evidence that a historic-property check is needed, including:

- A San Francisco location or 941xx ZIP.
- A New York City borough location or relevant NYC ZIP.
- A detected property/window age of 80 years or more.
- Historic, landmark, historic-district, or similar wording.
- Relevant location or ZIP information preserved in the Yellow Box notes.

## Official checks

- San Francisco opens the official SF Property Information Map with the detected address prepared in the link.
- New York copies the detected address and opens the official NYC historic-property checker for manual pasting.
- Other flagged locations receive a manual-review warning.

The official source and company policy remain authoritative. The script does not automatically declare a property historic or non-historic.

## Privacy and safety

The script reads visible lead information locally in the browser. It does not edit, submit, rename, or delete anything in Enabled+ and does not automatically send homeowner data to another service. An address is sent to an official checker only after the agent clicks the corresponding link.

No sampled homeowner or lead data is included in this repository.

## Updating

Tampermonkey uses the script's `@updateURL` and `@downloadURL` fields to check this repository for newer versions.

## Disclaimer

This is an unofficial workflow helper. It does not replace Enabled+, the official historic-property resources, company rules, or agent verification.
