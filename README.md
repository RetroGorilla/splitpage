# Splitpage

Splitpage is a two-column visual/audio script editor for people making
videos. Write what the viewer sees beside what they hear, plan the shoot,
and read the narration from a teleprompter.

![A film-camera video script with visual notes and narration side by side, coloured production tags, scene statuses and a timed rundown.](docs/images/readme/hero.png)

## Get Splitpage

There is no released installer here yet. Check the
[releases page](https://github.com/RetroGorilla/splitpage/releases) for
downloads when they are available.

To try it now, install the Node version in [.nvmrc](.nvmrc), then build from
source:

```sh
git clone --branch 4.1-development https://github.com/RetroGorilla/splitpage.git
cd splitpage
npm ci
node build.mjs
```

Open the generated `index.html` in your browser. To serve it locally, run
`start.bat` on Windows or `./start.sh` on macOS or Linux. For a Windows
desktop build, see the [development guide](https://github.com/RetroGorilla/splitpage/blob/4.1-development/docs/DEVELOPING.md).

You can write and save scripts offline. The desktop app saves directly to
your files; Chrome and Edge also support saving back to the same file.
Other browsers download a fresh copy when you save. Linked online videos
and browser speech recognition need an internet connection.

Start with the example script, or open the long demo to explore a complete
video. The [user guide](https://github.com/RetroGorilla/splitpage/blob/4.1-development/docs/help.md) explains the controls. The screenshots
below use the long demo in the current development app.

## Write the picture and the words together

Each scene keeps its visual notes beside its narration, with a read-time
estimate and a To do, Ready or Shot status. The rundown above the script
shows its pace and length; click a scene to jump to it.

![Three scenes of the camera-repair demo, with tagged visual notes beside narration, scene statuses and read times.](docs/images/readme/editor.png)

## Read from the teleprompter

Present turns the Audio column into a teleprompter with adjustable speed
and text size. Play one scene at a time, skip scenes already shot, or mirror
the text for a teleprompter display.

![The camera-repair narration in the dark teleprompter, with play, speed, text size, scene mode, mirror and flip controls.](docs/images/readme/teleprompter.png)

## Turn script notes into a production breakdown

Tag props, locations, cast, effects, sound and gear as you write. The
breakdown gathers each item with the scenes that need it, its status and
the person responsible, so you can see what still needs arranging.

<img src="docs/images/readme/production.png" width="490" alt="A production breakdown of props and locations for the camera-repair demo, showing sourcing status, scene numbers and assigned demo characters.">

## Keep a b-roll shot list

Start a visual line with `B-roll:` and it becomes a shot on the list. Tick
off footage as you get it, group shots by location, and flag a take that
needs shooting again.

<img src="docs/images/readme/broll.png" width="490" alt="The dark b-roll panel with camera-repair shots grouped by scene, completed checkboxes, locations and a reshoot flag.">

## Leave notes where they belong

Anchor a comment to words in either column, reply in its thread and resolve
it when the change is done. Clicking a comment takes you back to the passage
it refers to.

<img src="docs/images/readme/comments.png" width="490" alt="A comment on a line of narration, with a reply from a fictional demo character and controls to resolve or assign the thread.">

## Go back to an earlier draft

Version history keeps snapshots on your computer before changes that could
replace your work. Open the history for the current script and restore an
earlier version when you need it.

<img src="docs/images/readme/history.png" width="490" alt="Version history in the dark theme, listing snapshots before starting a new script and restoring an earlier version, with their times and scene counts.">

## Take the script into production

Export the script as PDF, Word, Markdown or a spreadsheet. You can also
export just the narration, production breakdown, packing list or b-roll
shot list, depending on what the next person needs.

![The export dialog with Word selected, a two-column script preview, and choices for narration, breakdown, packing list and b-roll exports.](docs/images/readme/exports.png)

## Project information

[Development setup and source map](https://github.com/RetroGorilla/splitpage/blob/4.1-development/docs/DEVELOPING.md) ·
[Developer handoff](https://github.com/RetroGorilla/splitpage/blob/4.1-development/docs/HANDOFF.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) ·
[Changelog](CHANGELOG.md) ·
[MIT licence](LICENSE)
