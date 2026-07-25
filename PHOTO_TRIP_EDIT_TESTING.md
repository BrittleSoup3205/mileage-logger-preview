# Photo Attachments and Trip Editing — Test Checklist

This branch is a test version. Do not merge it into the live app until the iPhone test is approved.

## Inspection photo test

1. Open **Inspections**.
2. Open an existing inspection or tap **New Inspection**.
3. Tap **Take Photo** and take a harmless test photo.
4. Confirm the photo preview appears.
5. Add a caption and save the inspection.
6. Reopen the inspection and confirm the photo and caption remain.
7. Tap the thumbnail and confirm the larger photo opens.

## Trip edit test

1. Open **View Log**.
2. Tap **Edit** beside a test trip.
3. Change an odometer value, vendor, or notes.
4. Confirm the mileage preview recalculates.
5. Tap **Save Trip Changes**.
6. Confirm the Trip Log shows the correction.
7. If the trip has a linked inspection, confirm its vendor, project, times, and mileage also changed.
8. Confirm GPS map links remain unchanged.

## Backup test

1. Confirm **BACKUP REQUIRED** appears after either change.
2. Tap **Save Full Backup to Files**.
3. Confirm the filename ends in `.zip`.
4. Save it outside the app and confirm the backup.
5. Restore that ZIP and confirm the trip, inspection, photo, and caption return.
6. Optionally restore an older `.json` backup and confirm it is still accepted.

