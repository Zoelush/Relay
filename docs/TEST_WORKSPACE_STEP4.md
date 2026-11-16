# The paired test workspace, T2b: the messenger, a help centre's look, and their images

Branch `feature/test-workspace-images`. Plan: `docs/TEST_WORKSPACE_PLAN.md`. Follows T2a
(`docs/TEST_WORKSPACE_STEP3.md`). Migration `0104_promotion_records.sql`.

## Decisions (asked, 16 November 2026)

1. **The help centre's look is promoted, and the ledger keeps the look it replaced.** A help
   centre's look is saved in place — it has no published versions of its own — so a promotion
   records the whole theme and homepage it replaced, and production's card offers **Put the
   previous look back**. That keeps T2a's promise (production can always get back what it had)
   without inventing a version history for the help centre in this step.
2. **An image comes with the change.** When a promoted messenger or look uses an image uploaded in
   the test workspace, its bytes are copied into production as production's own upload — a new id,
   a new stored object, and the reference in the promoted configuration rewritten to it. Trying a
   look in a test workspace is mostly about the images, so refusing would defeat the point.
   An image the test workspace got from production in the first place keeps its id and is left
   alone.
3. **The copy brings every upload the copied configuration names:** the messenger's images, Zoe's
   avatars, a help centre's theme and homepage images, and the images inside copied articles.
   Before this step a test workspace's copied messenger and help centre pointed at images that
   were never brought, so its most visual settings looked broken.

## What a promotion means for the two new kinds

- **The messenger** publishes numbered versions per brand, so it behaves exactly as T2a's
  workflows do: the version live in the test workspace becomes production's next
  `messenger_versions` row and is written into `brands.settings`, which is what the messenger
  itself reads. Production keeps every earlier version to restore.
- **A help centre's look** is its `theme` and `layout` — what "Configure and style" edits. Its
  name, address, languages and articles are not part of the look and are left as production has
  them. The promotion writes the look and bumps the help centre's version, and the ledger row
  holds the theme and layout it replaced.

## Images, both ways

One module, `server/uploads.ts`, moves an upload from one workspace to another: it reads the row
and the bytes in the workspace that has them, and writes a row and the bytes in the workspace that
needs them. Nothing is shared between the two — a copied image is the receiving workspace's own
object under its own key, so removing one workspace can never take the other's image away.

- **Making the pair** (`copyUploads`): every ready upload a copied row names — the images any
  copied messenger version or a brand's live settings uses, Zoe's avatars, each help centre's
  theme and homepage images, and the images in copied articles. Ids are kept, exactly as the rest
  of the copy keeps them, so the copied configuration still points at them.
- **Promoting** (`bringImages`): only the images production hasn't got. An image the copy brought
  keeps its id on both sides, so a promoted messenger that still uses production's own logo
  changes nothing about it. An image uploaded in the test workspace is inserted in production
  under a new id, and the promoted configuration is rewritten to name the new id. The ledger row
  says which images came with the promotion and what each one is.

The bytes are stored before the promotion's transaction opens, because their keys are known in
advance and a stored object nothing points at is harmless, while a row pointing at bytes that
aren't there yet is not.

## Refusing, in its own words

T2a's refusals apply unchanged (nothing changed here, changed in production, something missing,
a name already taken). The two new kinds add:

| What the card says | Why |
| --- | --- |
| Publish the messenger in the test workspace first | what is promoted is what you tried, never a draft |
| This brand isn't in production | a brand the test workspace invented |
| Production doesn't have this help centre | a help centre the test workspace invented |
| The homepage features an article production doesn't have, named | the look would point at nothing |
| Images can't be copied in this deployment | storage isn't configured, so an image can't come with it |

A collection image for a collection production doesn't have is left as it is: it names nothing
there, so nothing draws it, and dropping it quietly would change a look nobody asked to change.

## Putting a look back

The production card offers it for the newest promotion of a help centre's look, while the look is
still the one that promotion wrote. If somebody has styled the help centre since, putting the old
look back would overwrite that, so it is refused with that reason — the same rule as a promotion's
own conflict. A "put back" is appended to the ledger as its own row (`action='reverted'`), with an
audit event of its own, so the ledger reads as the whole history of what arrived and what was
undone.

## Checks

- **`tests/promote-images.test.ts`:** a pair whose production workspace has a messenger with an
  uploaded logo and a styled help centre. Then: the copy brings the images, with their bytes, and
  the copied configuration still finds them; a messenger changed in the test workspace with a new
  image promoted as production's next version, the image arriving as production's own upload with
  a new id and the reference rewritten; the ledger saying which images came; a look promoted and
  put back; a put-back refused once production has styled the centre since; a brand and a help
  centre the test workspace invented refused by name; a featured article production hasn't got
  refused by name.
- **`tests/browser/test-workspace.spec.ts`:** a fourth case end to end — the messenger's look
  changed in the test workspace, promoted from Settings › General, and production's messenger
  settings showing the new version with its image.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**T3:** the developer sandbox (phase 15's D6) on the same pairing.
