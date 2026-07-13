MILEAGE LOGGER GPS + PRIVATE STA + REQUIRED BACKUP
==================================================

BACKUP IS NOW A REQUIRED PART OF THE WORKFLOW
---------------------------------------------
When a completed trip is saved, the app immediately creates one full JSON restore file and opens the iPhone share sheet.

On iPhone:
1. Tap Save Completed Trip.
2. The share sheet opens automatically.
3. Choose Save to Files.
4. Choose an iCloud Drive folder, such as Mileage Logger Backups.
5. Tap Save.
6. Return to Mileage Logger.
7. Confirm that the external file was saved.

The app blocks the next Start Trip until the prior completed trip has a confirmed backup.

WHAT THE FULL BACKUP CONTAINS
-----------------------------
- All completed trips
- Active trip, if one exists
- Odometer values
- GPS coordinates and route points
- Customer, vendor, project, purpose, and notes
- Facility and safety-contact profiles
- App settings
- STA-generated status and filenames

The private STA master PDF is intentionally not included. Keep the original master PDF separately in Files.

BACKUP FILE NAME
----------------
Example:
Mileage_Logger_Full_Backup_2026-07-13_083512_42_trips.json

The latest full backup is enough to restore the complete mileage database. Older backups can be retained for additional history.

RESTORE
-------
Use Restore a Backup or Restore Backup, then choose the JSON file from Files. Restoring replaces the current mileage app data.

CSV
---
CSV is a readable spreadsheet copy but is not the complete restore file. Use the JSON file as the required backup.

PRIVATE STA
-----------
The hosted package does not contain the STA master. Import the approved master privately from the iPhone Files app.

IMPORTANT
---------
The app cannot silently write into an iCloud Drive folder. iPhone security requires the Save to Files selection. The app reduces the process to the native share sheet, folder choice, Save, and a confirmation.
