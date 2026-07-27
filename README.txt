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

PHOTOS IN FULL BACKUPS
----------------------
Photos in new full ZIP backups use normal .jpg, .png, .webp, or .heic filenames.
They can be opened directly on a computer after the ZIP is extracted. Older backups containing .bin photo files remain fully restorable.

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

INSPECTION PACKAGES
-------------------
Open Inspection History and tap Export Package on an inspection record.
The computer-friendly ZIP contains:
- A printable PDF inspection report
- An editable Word inspection report
- A plain-text inspection update
- An Excel-readable CSV data file
- An HTML photo index
- A Photos folder with normal image filenames

Inspection packages are for reporting and recordkeeping. They do not replace the required full restore backup.

PRIVATE S&B WORD REPORT TEMPLATE
--------------------------------
Open Inspections and use Import S&B Word Template.
Choose the approved blank S&B inspection report in .docx format.
The template is stored only in this browser on this device and is not uploaded to GitHub or included in backups.
When installed, Export Package uses the S&B layout for the editable Word report and inserts available inspection data plus up to four attached photos.
Keep the original blank S&B template safely in Files because clearing website data or removing the web app can remove the private imported copy.

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
