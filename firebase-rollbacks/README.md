# Firestore Rules rollback snapshot

Rollback source: GitHub `main` commit `2f3ed8988aedd38bbd13b657a626541660866ce2` (`Merge secure online booking management`).

Saved files:

- `firestore.rules.main-2f3ed898.rules` — byte-for-byte archive of the rules from that main commit.
- `firestore.rules.safe-rollback-client-history.rules` — operational rollback that preserves current-main behavior while keeping all new private/internal collections closed.

Expected Git blob SHA: `9ab47f3de5adb683c179a072c76d480ce4eee129`

Safe operational rollback Git blob SHA: `980dc24c206eb1bd25afad4cd12013dc213fe5b2`

Neither file is referenced by any production `firebase.json`, so ordinary deploy commands cannot select it accidentally.

## Which rollback file to use

The exact archived rules are safe only before any private client-history document exists. Do **not** deploy the exact archive after new Functions or the historical backfill has written `appointmentPrivate`, `clientLookup`, `clientProfiles`, `clientPhoneIndex`, or `clientAppointmentHistory`: its legacy fallback would allow signed-in staff to access those collections.

After the new backend has been enabled even briefly, use `firestore.rules.safe-rollback-client-history.rules`. It restores the old calendar permissions, including the old `activityLog` behavior, but permanently keeps the private and internal collections closed.

Firestore Rules do not have a one-click release rollback. To restore the selected snapshot, first copy its exact contents over the configured `salon-calendar/firestore.rules`, verify the chosen file, run the Rules emulator tests, and then publish only Rules:

`firebase deploy --only firestore:rules --project rosesnails-calendar`

Restoring the file creates a new Rules release. It does not undo data written while another ruleset was active. Always verify the active project and preserve the failed ruleset before restoring.

The safe rollback was verified in the Firestore Emulator with:

`firebase emulators:exec --config firebase.safe-rollback-emulator.json --only firestore --project demo-client-history-safe-rollback "npm --prefix salon-functions/functions run test:safe-rollback"`
