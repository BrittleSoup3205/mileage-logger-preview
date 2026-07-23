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

## Current integrated build

The inspection database is now loaded directly by `index.html` from the normal
`inspections.js` source file. The temporary compressed payload, loader, and
separate preview page have been removed.

The working production branch, `main`, is unchanged. Test this integrated build
from the `inspection-database-phase-1` branch before merging.

## Test sequence

1. Open `index.html` and confirm the Inspections button and Inspect navigation item appear.
2. Confirm Start Trip, End Trip, GPS, private STA import/generation, mileage CSV, required backup, and restore still operate.
3. Create one standalone inspection.
4. Create one inspection linked to a completed mileage trip.
5. Add two follow-ups, close one from the Open Follow-ups view, and edit the inspection.
6. Export the inspection CSV.
7. Save a full JSON backup, restore it, and verify the inspection records and follow-ups return.
8. Restore an older mileage-only backup and verify the inspection database opens empty without an error.
9. Reload while offline and confirm the inspection interface still opens.

Do not merge the inspection interface into `main` until this sequence has been completed on the intended iPhone/iPad and desktop browsers.

