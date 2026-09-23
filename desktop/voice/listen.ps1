# Splitpage desktop — Follow My Voice's listener (issue #8).
#
# Run by desktop/voice-helper.js, one process per listening session, with
# Windows' own powershell.exe. It listens to the default microphone through
# the speech recogniser Windows already has (System.Speech, SAPI — offline,
# nothing downloaded, no model shipped with the app) and writes what it hears
# to stdout, one JSON object per line:
#
#   {"type":"start","lang":"en-US"}      listening
#   {"type":"interim","text":"..."}      a guess that may still change
#   {"type":"final","text":"..."}        a phrase the recogniser settled on
#   {"type":"warning","code":"..."}      no-signal / too-quiet / too-noisy
#   {"type":"error","code":"..."}        no-recognizer / audio-capture /
#                                        recognizer-failed / helper-failed
#
# It stops when its stdin closes: that is how main ends a session, and it is
# also what happens when main exits for any reason, so no listener can
# outlive the app holding the microphone.
#
# It takes no arguments and reads nothing but stdin. Which recogniser it uses
# is decided here, from what Windows has installed: the display language's
# if there is one, then US English, then any English, then whatever exists.
#
# Why System.Speech and not Windows.Media.SpeechRecognition: the WinRT
# recogniser's dictation needs Windows' "Online speech recognition" setting
# on and sends the audio to Microsoft, and awaiting WinRT calls from Windows
# PowerShell 5.1 is fragile. System.Speech is in every Windows 10 and 11
# install's .NET Framework and runs entirely on the machine.

$ErrorActionPreference = 'Stop'

function Write-Line([string]$json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  Add-Type -AssemblyName System.Speech
  # The event handlers are C#, not PowerShell script blocks: the recogniser
  # raises its events on its own threads, and a PowerShell handler only runs
  # when the pipeline is idle — which it never is while this script sits in
  # ReadLine below.
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;

public static class SplitpageVoice {
  static readonly object Gate = new object();

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < ' ') b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  public static void Emit(string type, string key, string value) {
    string line = "{\"type\":" + Json(type) + ",\"" + key + "\":" + Json(value) + "}";
    lock (Gate) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }
  }

  static RecognizerInfo Pick() {
    var all = SpeechRecognitionEngine.InstalledRecognizers();
    if (all.Count == 0) return null;
    string ui = CultureInfo.CurrentUICulture.Name;
    foreach (var r in all) if (r.Culture.Name == ui) return r;
    foreach (var r in all) if (r.Culture.Name == "en-US") return r;
    foreach (var r in all) if (r.Culture.TwoLetterISOLanguageName == "en") return r;
    return all[0];
  }

  public static SpeechRecognitionEngine Start() {
    RecognizerInfo pick = Pick();
    if (pick == null) { Emit("error", "code", "no-recognizer"); return null; }
    var engine = new SpeechRecognitionEngine(pick);
    try {
      engine.SetInputToDefaultAudioDevice();
    } catch (InvalidOperationException) {
      engine.Dispose();
      Emit("error", "code", "audio-capture");
      return null;
    }
    engine.LoadGrammar(new DictationGrammar());
    engine.SpeechHypothesized += (s, e) => Emit("interim", "text", e.Result.Text);
    engine.SpeechRecognized += (s, e) => Emit("final", "text", e.Result.Text);
    engine.AudioSignalProblemOccurred += (s, e) => {
      if (e.AudioSignalProblem == AudioSignalProblem.NoSignal) Emit("warning", "code", "no-signal");
      else if (e.AudioSignalProblem == AudioSignalProblem.TooSoft) Emit("warning", "code", "too-quiet");
      else if (e.AudioSignalProblem == AudioSignalProblem.TooNoisy) Emit("warning", "code", "too-noisy");
    };
    engine.RecognizeCompleted += (s, e) => {
      if (e.Error != null) Emit("error", "code", "recognizer-failed");
    };
    engine.RecognizeAsync(RecognizeMode.Multiple);
    Emit("start", "lang", pick.Culture.Name);
    return engine;
  }
}
'@

  $engine = [SplitpageVoice]::Start()
  if ($null -eq $engine) { exit 2 }

  # Block until main closes stdin. Everything heard in the meantime is written
  # by the C# handlers above, on the recogniser's threads.
  while ($null -ne [Console]::In.ReadLine()) { }

  try { $engine.RecognizeAsyncCancel() } catch { }
  $engine.Dispose()
  exit 0
} catch {
  Write-Line '{"type":"error","code":"helper-failed"}'
  exit 1
}
