MILEAGE LOGGER GPS + PRIVATE STA + REQUIRED BACKUP
==================================================

BACKUP IS NOW A REQUIRED PART OF THE WORKFLOW
---------------------------------------------
When a completed trip or saved record is changed, the app creates one full ZIP restore file.
The ZIP contains the normal app data plus privately stored inspection photos.

On iPhone:
1. Tap Save Completed Trip.
2. The share sheet opens automatically.
3. Choose Save to Files.
4. Choose an iCloud Drive folder, such as Mileage Logger Backups.
5. Tap Save.
6. Return to Mileage Logger.
7. Confirm that the external file was saved.

The app blocks the next Start Trip until trips and record changes have a confirmed backup.

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
- Inspection records and follow-ups
- Compressed inspection photos and captions

The private STA master PDF is intentionally not included. Keep the original master PDF separately in Files.

BACKUP FILE NAME
----------------
Example:
Mileage_Logger_Full_Backup_2026-07-13_083512_42_trips.zip

The latest full backup is enough to restore the complete mileage database. Older backups can be retained for additional history.

RESTORE
-------
Use Restore a Backup or Restore Backup, then choose the ZIP file from Files. Restoring replaces the current mileage app data and inspection photos.
Older JSON backups remain supported. They restore the app data and leave existing private photos on the device untouched.

CSV
---
CSV is a readable spreadsheet copy but is not the complete restore file. Use the ZIP file as the required backup.

TRIP LOG CORRECTIONS
--------------------
Open View Log and tap Edit beside a saved trip. Customer, vendor, project, purpose, date, times, odometers, and notes can be corrected.
Mileage is recalculated. Original GPS locations and route points are preserved. Linked inspection records are updated.

PRIVATE STA
-----------
The hosted package does not contain the STA master. Import the approved master privately from the iPhone Files app.

IMPORTANT
---------
The app cannot silently write into an iCloud Drive folder. iPhone security requires the Save to Files selection. The app reduces the process to the native share sheet, folder choice, Save, and a confirmation.
