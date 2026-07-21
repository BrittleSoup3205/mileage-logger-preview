# Phase 2A — Inspection Database

This development branch adds the first inspection-record system without replacing the existing mileage, GPS, STA, backup, restore, or offline features.

## Included

- Trip-linked and standalone inspection records
- Automatic copying of customer, vendor, project, date, time, mileage, GPS, and STA status from a selected trip
- Inspection dashboard and searchable history
- Multiple follow-up actions with open/closed tracking
- Direct Apple Maps links from linked trip records
- Inspection CSV export
- A completed-trip prompt after the required mileage backup is confirmed
- Storage inside `settings.inspections`, keeping inspection records inside the existing full JSON backup
- Compatibility with older backups that do not contain inspection records
- A separate inspection-backup warning when inspection changes are newer than the last confirmed full backup

## Current preview

Open `phase2.html` on the `inspection-database-phase-1` branch. The preview reads the same local browser storage as the existing Mileage Logger page on the same origin.

## Test sequence

1. Confirm the existing Start Trip, End Trip, GPS, STA, CSV, backup, and restore functions still operate in `index.html`.
2. Open `phase2.html`.
3. Create one standalone inspection.
4. Create one inspection linked to a completed mileage trip.
5. Add two follow-ups, close one from the Open Follow-ups view, and edit the inspection.
6. Export the inspection CSV.
7. Return to `index.html`, save a full JSON backup, restore it, and verify the inspection records and follow-ups return.
8. Restore an older mileage-only backup and verify the inspection database opens empty without an error.

Do not merge the inspection interface into `main` until this sequence has been completed on the intended iPhone/iPad and desktop browsers.
