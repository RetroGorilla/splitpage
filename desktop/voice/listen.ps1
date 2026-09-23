# Splitpage desktop — Follow My Voice's listener (issue #8).
#
# Run by desktop/voice-helper.js, one process per listening session, with
# Windows' own powershell.exe. It listens to the default microphone through
# the speech recogniser Windows already has (System.Speech, SAPI — offline,
# nothing downloaded, no model shipped with the app) and writes what it hears
# to stdout, one JSON object per line:
#
#   {"type":"device","name":"..."}       the microphone it listens to, just
#                                        before start, when Windows names it
#                                        (issue #118)
#   {"type":"start","lang":"en-US"}      listening
#   {"type":"interim","text":"..."}      a guess that may still change
#   {"type":"final","text":"..."}        a phrase the recogniser settled on
#   {"type":"warning","code":"..."}      no-signal / too-quiet / too-noisy,
#                                        or clear: the no-signal / too-quiet
#                                        it said last is over (issue #117)
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
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Text;

// Which microphone SetInputToDefaultAudioDevice listens to (issue #118).
// System.Speech does not say, so this asks Windows' Core Audio for the
// default capture endpoint (eCapture, eConsole — the one the wave mapper,
// and so SAPI, records from) and reads its friendly name, e.g.
// "Microphone (USB Audio Device)". Reading a property does not open the
// device. Null when there is no such device or anything fails: the page
// then just says "Listening".
public static class SplitpageVoiceDevice {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    void OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out int count);
    void GetAt(int index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PropertyKey {
    public Guid FormatId;
    public int PropertyId;
  }

  // Big enough for a PROPVARIANT on x86 (16 bytes) and x64 (24).
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Pointer;
  }

  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PropVariant value);

  const int ECapture = 1, EConsole = 0, StgmRead = 0;
  const ushort VtLpwstr = 31;

  public static string DefaultCaptureName() {
    try {
      var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      devices.GetDefaultAudioEndpoint(ECapture, EConsole, out device);
      IPropertyStore store;
      device.OpenPropertyStore(StgmRead, out store);
      // PKEY_Device_FriendlyName
      var key = new PropertyKey { FormatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), PropertyId = 14 };
      PropVariant value;
      store.GetValue(ref key, out value);
      try {
        if (value.Type != VtLpwstr || value.Pointer == IntPtr.Zero) return null;
        string name = Marshal.PtrToStringUni(value.Pointer);
        return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
      } finally {
        PropVariantClear(ref value);
      }
    } catch (Exception) {
      return null;
    }
  }
}

// When no-signal and too-quiet are worth saying (issue #117). The recogniser
// raises NoSignal the moment it starts, while the room is still quiet, and
// TooSoft for one quiet moment, so passed straight through they flash a
// warning before anyone has spoken. This holds them back: nothing within
// GraceMs of starting, no-signal only once GraceMs has gone by with no audio
// level at or above LevelFloor and nothing recognised, too-quiet only when
// the recogniser says it again at least GraceMs after it first did with
// nothing recognised in between. Once one is shown, audio arriving (for
// no-signal) or words arriving (for either) sends "clear".
//
// Pure: the caller passes the time in, in milliseconds, and sends whatever
// code comes back (a warning, "clear", or null for nothing), so
// desktop/test/voice-grace.test.mjs can run it with a clock of its own and
// no microphone.
public sealed class SplitpageVoiceGrace {
  public const long GraceMs = 5000;
  public const int LevelFloor = 1;   // AudioLevelUpdated runs 0-100
  long started, lastSignal, lastSpeech, pendingSince;
  string pending;   // reported by the recogniser, not shown yet
  string shown;     // what is on screen, if it is one of these two

  public SplitpageVoiceGrace(long now) {
    started = lastSignal = lastSpeech = now;
  }

  public string Level(long now, int level) {
    if (level < LevelFloor) return null;
    lastSignal = now;
    if (pending == "no-signal") pending = null;
    if (shown == "no-signal") { shown = null; return "clear"; }
    return null;
  }

  public string Heard(long now) {
    lastSignal = lastSpeech = now;
    pending = null;
    if (shown != null) { shown = null; return "clear"; }
    return null;
  }

  public string Problem(long now, string code) {
    if (pending != code) { pending = code; pendingSince = now; return Tick(now); }
    if (code == "too-quiet" && Due(now) && now - pendingSince >= GraceMs) return Show();
    return Tick(now);
  }

  public string Tick(long now) {
    if (pending == "no-signal" && Due(now)) return Show();
    return null;
  }

  bool Due(long now) {
    if (pending == null || pending == shown || now - started < GraceMs) return false;
    return now - (pending == "no-signal" ? lastSignal : lastSpeech) >= GraceMs;
  }

  string Show() {
    shown = pending;
    pending = null;
    return shown;
  }
}

public static class SplitpageVoice {
  static readonly object Gate = new object();
  static SplitpageVoiceGrace grace;
  static System.Diagnostics.Stopwatch clock;
  static System.Threading.Timer ticker;

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
    clock = System.Diagnostics.Stopwatch.StartNew();
    grace = new SplitpageVoiceGrace(0);
    engine.SpeechHypothesized += (s, e) => { Warn(() => grace.Heard(Now())); Emit("interim", "text", e.Result.Text); };
    engine.SpeechRecognized += (s, e) => { Warn(() => grace.Heard(Now())); Emit("final", "text", e.Result.Text); };
    engine.AudioLevelUpdated += (s, e) => Warn(() => grace.Level(Now(), e.AudioLevel));
    engine.AudioSignalProblemOccurred += (s, e) => {
      if (e.AudioSignalProblem == AudioSignalProblem.NoSignal) Warn(() => grace.Problem(Now(), "no-signal"));
      else if (e.AudioSignalProblem == AudioSignalProblem.TooSoft) Warn(() => grace.Problem(Now(), "too-quiet"));
      else if (e.AudioSignalProblem == AudioSignalProblem.TooNoisy) Emit("warning", "code", "too-noisy");
    };
    engine.RecognizeCompleted += (s, e) => {
      if (e.Error != null) Emit("error", "code", "recognizer-failed");
    };
    engine.RecognizeAsync(RecognizeMode.Multiple);
    string mic = SplitpageVoiceDevice.DefaultCaptureName();
    if (mic != null) Emit("device", "name", mic);
    Emit("start", "lang", pick.Culture.Name);
    // no-signal is due by the clock, not by another event: the recogniser
    // may never raise it again after the first time.
    ticker = new System.Threading.Timer(_ => Warn(() => grace.Tick(Now())), null, 250, 250);
    return engine;
  }

  static long Now() {
    return clock.ElapsedMilliseconds;
  }

  // Sends what the grace period decided, if anything. Under Gate so the
  // grace state is only ever touched by one of the recogniser's threads, or
  // the timer's, at a time.
  static void Warn(Func<string> decide) {
    lock (Gate) {
      string code = decide();
      if (code != null) Emit("warning", "code", code);
    }
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
