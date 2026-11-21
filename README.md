# Splitpage

Splitpage is a two-column visual/audio script editor for people making
videos. Write what the viewer sees beside what they hear, plan the shoot,
and read the narration from a teleprompter.

![A film-camera video script with visual notes and narration side by side, coloured production tags, beat statuses and a timed rundown.](docs/images/readme/hero.png)

## Get Splitpage

The latest release is **[0.4.3](https://github.com/RetroGorilla/splitpage/releases/tag/v0.4.3)** ([what's new](CHANGELOG.md) · [roadmap](docs/ROADMAP.md)).

- **Windows desktop app:** Download the installer (`x64` or `arm64`) or portable `.zip` from the [latest release](https://github.com/RetroGorilla/splitpage/releases/latest). *(The installers are unsigned, so Windows SmartScreen warns on first run: choose **More info**, then **Run anyway**.)*
- **First steps:** Start with the example script, or open the long demo to explore a complete video. The [user guide](docs/help.md) explains the controls.
- **Offline & saving:** Write and save scripts offline. The desktop app saves directly to your files, and Chrome and Edge also save back to the same file (other browsers download a fresh copy when you save). Linked online videos and browser speech recognition need an internet connection.

<details>
<summary><strong>Run in a browser or build from source</strong></summary>

Install the Node version in [.nvmrc](.nvmrc), then:

```sh
git clone https://github.com/RetroGorilla/splitpage.git
cd splitpage
npm ci
node build.mjs
```

Open the generated `index.html` in your browser, or serve it locally with `start.bat` on Windows or `./start.sh` on macOS and Linux. For a Windows desktop build, see the [development guide](docs/DEVELOPING.md).

</details>

## Write the picture and the words together

- **Two-column beats:** Each beat keeps its visual notes beside its narration, with a read-time estimate and a **To do**, **Ready** or **Filmed** status.
- **Scenes & rundown:** Named scene headers group beats with labels such as `A1` and `B1`. The rundown bar above the script shows its pace and length; click any beat to jump straight to it.
- **Flowing writer:** Switch to **Write** whenever you want to draft or edit narration as a continuous, distraction-free document while keeping every beat in sync.

![Three beats of the camera-repair demo with tagged visual notes, narration, statuses and read times.](docs/images/readme/editor.png)

## Read from the teleprompter

**Present** turns the Audio column into a teleprompter with adjustable speed
and text size. Play one beat at a time in Beat mode, skip filmed beats, or
mirror the text for a physical teleprompter glass.

![The camera-repair narration in the dark teleprompter with speed, text size, Beat mode and Skip filmed controls.](docs/images/readme/teleprompter.png)

## Plan the shoot and review drafts

Tag props, locations, cast, effects, sound and gear as you write—including nested tags inside other tags (use **Edit tag** and **Done** to label words inside a finished tag):

- **Breakdown & Scene prep:** Gather every tagged item with the beats that need it, its sourcing status and the person responsible, or walk through requirements scene by scene and beat by beat.
- **Shoot & By scene:** View each location's beats under scene headings with filmed and current indicators, or group Production, Gear, B-roll and Comments by scene.
- **B-roll shot list:** Start a visual line with `B-roll:` and it becomes a trackable shot on the list—tick off footage as you get it, group shots by location, and flag takes that need a reshoot.
- **Inline comments & version history:** Anchor comment threads to words in either column, jump back to the exact passage with a click, and restore local version history snapshots whenever you need an earlier draft.

<table>
  <tr>
    <td valign="top" width="50%">
      <strong>Production breakdown</strong><br>
      <img src="docs/images/readme/production.png" alt="The production breakdown showing props, locations, sourcing status, beat references and assigned crew.">
    </td>
    <td valign="top" width="50%">
      <strong>B-roll shot list</strong><br>
      <img src="docs/images/readme/broll.png" alt="The dark b-roll panel with shots grouped by beat, completed checkboxes, locations and a reshoot flag.">
    </td>
  </tr>
  <tr>
    <td valign="top" width="50%">
      <strong>Inline comments</strong><br>
      <img src="docs/images/readme/comments.png" alt="A comment anchored to a line of narration, with a reply thread and controls to resolve or assign.">
    </td>
    <td valign="top" width="50%">
      <strong>Version history</strong><br>
      <img src="docs/images/readme/history.png" alt="Version history in the dark theme, listing local snapshots with their times and beat counts.">
    </td>
  </tr>
</table>

## Take the script into production

- **Flexible exports:** Export the full script as PDF, Word, Markdown or a spreadsheet—or export just the narration, production breakdown, packing list or b-roll shot list depending on what the next person needs.
- **Attachments & project bundles:** Attach pictures and local reference files to beats. Pictures are embedded inside saved projects; in the desktop app, **Create bundle** gathers linked local files into a folder beside the script and can package everything into a single `.zip`.

![The export dialog with Word selected, a two-column script preview, and choices for narration, breakdown, packing list and b-roll exports.](docs/images/readme/exports.png)

## Project information

[Development setup and source map](docs/DEVELOPING.md) ·
[Developer handoff](docs/HANDOFF.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) ·
[Changelog](CHANGELOG.md) ·
[MIT licence](LICENSE)
