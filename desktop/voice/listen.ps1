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
#   {"type":"warning","code":"..."}      no-signal / too-quiet / too-noisy /
#                                        blocked-all / blocked-desktop, or
#                                        clear: whichever of those it said
#                                        last is over (issue #117, #134)
#   {"type":"error","code":"..."}        no-recognizer / audio-capture /
#                                        recognizer-failed / helper-failed
#
# It stops when its stdin closes: that is how main ends a session, and it is
# also what happens when main exits for any reason, so no listener can
# outlive the app holding the microphone.
#
# why: -Device takes a Core Audio endpoint id because System.Speech can only open the default microphone itself;
# -List prints {"type":"microphones","list":[{"id","name"}]} so the page offers exactly the ids -Device accepts.
#
# Why System.Speech and not Windows.Media.SpeechRecognition: the WinRT
# recogniser's dictation needs Windows' "Online speech recognition" setting
# on and sends the audio to Microsoft, and awaiting WinRT calls from Windows
# PowerShell 5.1 is fragile. System.Speech is in every Windows 10 and 11
# install's .NET Framework and runs entirely on the machine.

param([string]$Device = "", [switch]$List)

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
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

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
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    void GetCount(out int count);
    void Item(int index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    void OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out int state);
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

  const int ECapture = 1, EConsole = 0, StgmRead = 0, DeviceStateActive = 1;
  const ushort VtLpwstr = 31;

  public static string DefaultCaptureName() {
    try {
      var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      devices.GetDefaultAudioEndpoint(ECapture, EConsole, out device);
      return NameOf(device);
    } catch (Exception) {
      return null;
    }
  }

  static string NameOf(IMMDevice device) {
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
  }

  public static string[][] ActiveCapture() {
    var found = new List<string[]>();
    try {
      var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDeviceCollection all;
      devices.EnumAudioEndpoints(ECapture, DeviceStateActive, out all);
      int count;
      all.GetCount(out count);
      for (int i = 0; i < count; i++) {
        try {
          IMMDevice device;
          all.Item(i, out device);
          string id;
          device.GetId(out id);
          string name = NameOf(device);
          if (!string.IsNullOrEmpty(id) && name != null) found.Add(new[] { id, name });
        } catch (Exception) { }
      }
    } catch (Exception) { }
    return found.ToArray();
  }

  public static string ActiveCaptureName(string id) {
    try {
      var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      devices.GetDevice(id, out device);
      int state;
      device.GetState(out state);
      if (state != DeviceStateActive) return null;
      return NameOf(device) ?? "";
    } catch (Exception) {
      return null;
    }
  }
}

public sealed class SplitpageVoiceInput : Stream {
  readonly Queue<byte[]> chunks = new Queue<byte[]>();
  byte[] current;
  int at;
  bool finished;

  public void Push(byte[] chunk) {
    lock (chunks) { chunks.Enqueue(chunk); Monitor.PulseAll(chunks); }
  }

  public void Finish() {
    lock (chunks) { finished = true; Monitor.PulseAll(chunks); }
  }

  // why: the recogniser reads a short count as the end of the audio, so a read waits until it
  // can fill the whole buffer, and returns short only once the capture has finished.
  public override int Read(byte[] buffer, int offset, int count) {
    int got = 0;
    while (got < count) {
      lock (chunks) {
        while ((current == null || at >= current.Length) && chunks.Count == 0 && !finished) Monitor.Wait(chunks);
        if (current == null || at >= current.Length) {
          if (chunks.Count == 0) return got;
          current = chunks.Dequeue();
          at = 0;
        }
      }
      int n = Math.Min(count - got, current.Length - at);
      Buffer.BlockCopy(current, at, buffer, offset + got, n);
      at += n;
      got += n;
    }
    return got;
  }

  public override bool CanRead { get { return true; } }
  public override bool CanSeek { get { return false; } }
  public override bool CanWrite { get { return false; } }
  // why: System.Speech asks a stream for its length and position up front; an endless capture has neither.
  public override long Length { get { return -1; } }
  public override long Position { get { return 0; } set { } }
  public override void Flush() { }
  public override long Seek(long offset, SeekOrigin origin) { return 0; }
  public override void SetLength(long value) { }
  public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

public static class SplitpageVoiceLevel {
  // why: SAPI raises no level or no-signal events for stream input, so the grace period gets its level
  // from the samples: any non-zero sample is a signal, as a muted or dead device delivers exact zeros.
  public static int Of(byte[] pcm, int count) {
    int peak = 0;
    for (int i = 0; i + 1 < count; i += 2) {
      int v = (short)(pcm[i] | (pcm[i + 1] << 8));
      if (v < 0) v = -v;
      if (v > peak) peak = v;
    }
    if (peak == 0) return 0;
    return Math.Max(1, Math.Min(100, peak * 100 / 32768));
  }
}

public sealed class SplitpageVoiceCapture {
  [StructLayout(LayoutKind.Sequential)]
  struct WaveFormat {
    public short Tag, Channels;
    public int Rate, BytesPerSecond;
    public short Align, Bits, Extra;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct WaveHeader {
    public IntPtr Data;
    public int Length, Recorded;
    public IntPtr User;
    public int Flags, Loops;
    public IntPtr Next, Reserved;
  }

  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll")] static extern int waveInMessage(IntPtr device, int message, ref int size, IntPtr unused);
  [DllImport("winmm.dll")] static extern int waveInMessage(IntPtr device, int message, IntPtr buffer, IntPtr size);
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, int device, ref WaveFormat format, IntPtr callback, IntPtr instance, int flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);

  const int QueryEndpointIdSize = 0x0812, QueryEndpointId = 0x0811, CallbackEvent = 0x50000, HeaderDone = 1;
  const int Rate = 16000, BufferBytes = 3200, Buffers = 4;

  public readonly SplitpageVoiceInput Input = new SplitpageVoiceInput();
  public Action<int> Level;
  public Action Lost;
  readonly string endpoint;
  readonly AutoResetEvent ready = new AutoResetEvent(false);
  readonly IntPtr[] headers = new IntPtr[Buffers];
  readonly int headerSize = Marshal.SizeOf(typeof(WaveHeader));
  IntPtr handle;
  volatile bool stopping;
  int lost;
  Thread reader;
  Timer watch;

  SplitpageVoiceCapture(string endpoint) { this.endpoint = endpoint; }

  static string EndpointOf(int index) {
    int size = 0;
    if (waveInMessage((IntPtr)index, QueryEndpointIdSize, ref size, IntPtr.Zero) != 0 || size <= 0 || size > 4096) return null;
    IntPtr text = Marshal.AllocHGlobal(size);
    try {
      return waveInMessage((IntPtr)index, QueryEndpointId, text, (IntPtr)size) == 0 ? Marshal.PtrToStringUni(text) : null;
    } finally {
      Marshal.FreeHGlobal(text);
    }
  }

  public static int WaveIndexOf(string endpoint) {
    int count = waveInGetNumDevs();
    for (int i = 0; i < count; i++) {
      if (string.Equals(EndpointOf(i), endpoint, StringComparison.OrdinalIgnoreCase)) return i;
    }
    return -1;
  }

  public static SplitpageVoiceCapture Open(string endpoint) {
    int index = WaveIndexOf(endpoint);
    if (index < 0) return null;
    var capture = new SplitpageVoiceCapture(endpoint);
    var format = new WaveFormat { Tag = 1, Channels = 1, Rate = Rate, BytesPerSecond = Rate * 2, Align = 2, Bits = 16, Extra = 0 };
    if (waveInOpen(out capture.handle, index, ref format, capture.ready.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CallbackEvent) != 0) return null;
    for (int i = 0; i < Buffers; i++) {
      IntPtr header = Marshal.AllocHGlobal(capture.headerSize);
      Marshal.StructureToPtr(new WaveHeader { Data = Marshal.AllocHGlobal(BufferBytes), Length = BufferBytes }, header, false);
      capture.headers[i] = header;
      if (waveInPrepareHeader(capture.handle, header, capture.headerSize) != 0 ||
          waveInAddBuffer(capture.handle, header, capture.headerSize) != 0) {
        capture.Stop();
        return null;
      }
    }
    return capture;
  }

  public void Start() {
    reader = new Thread(Pump) { IsBackground = true };
    reader.Start();
    watch = new Timer(_ => { if (SplitpageVoiceDevice.ActiveCaptureName(endpoint) == null) GoneAway(); }, null, 1000, 1000);
    if (waveInStart(handle) != 0) GoneAway();
  }

  void Pump() {
    while (!stopping) {
      ready.WaitOne(250);
      foreach (IntPtr header in headers) {
        var h = (WaveHeader)Marshal.PtrToStructure(header, typeof(WaveHeader));
        if ((h.Flags & HeaderDone) == 0 || stopping) continue;
        if (h.Recorded > 0) {
          var chunk = new byte[h.Recorded];
          Marshal.Copy(h.Data, chunk, 0, h.Recorded);
          Input.Push(chunk);
          var level = Level;
          if (level != null) level(SplitpageVoiceLevel.Of(chunk, chunk.Length));
        }
        h.Flags &= ~HeaderDone;
        h.Recorded = 0;
        Marshal.StructureToPtr(h, header, false);
        if (waveInAddBuffer(handle, header, headerSize) != 0) { GoneAway(); return; }
      }
    }
  }

  void GoneAway() {
    if (stopping || Interlocked.Exchange(ref lost, 1) != 0) return;
    var gone = Lost;
    if (gone != null) gone();
  }

  public void Stop() {
    stopping = true;
    if (watch != null) watch.Dispose();
    Input.Finish();
    if (handle == IntPtr.Zero) return;
    waveInReset(handle);
    if (reader != null && reader != Thread.CurrentThread) reader.Join(1000);
    foreach (IntPtr header in headers) {
      if (header == IntPtr.Zero) continue;
      waveInUnprepareHeader(handle, header, headerSize);
    }
    waveInClose(handle);
    handle = IntPtr.Zero;
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

// Whether Windows is outright blocking the microphone (issue #134), read
// from the consent store the Privacy & security ▸ Microphone switches write
// to. Unlike no-signal/too-quiet this needs no grace period: a "Deny" here
// is certain, not a guess from silence.
//
// Check() takes the registry lookup as a delegate rather than reading the
// registry itself, so desktop/test/voice-grace.test.mjs can drive every
// combination with a fake reader and never touch the real registry or open
// a microphone (invariant #33).
public static class SplitpageVoiceConsent {
  // hklm-all:      HKLM ConsentStore\microphone Value       (device-wide
  //                "Microphone access" switch, every user and app)
  // hkcu-all:      HKCU ConsentStore\microphone Value       (this user,
  //                "Let apps access your microphone")
  // hkcu-desktop:  HKCU ConsentStore\microphone\NonPackaged Value (this
  //                user, "Let desktop apps access your microphone")
  // A reader returns "Allow", "Deny", or null when the value has never been
  // set (which Windows treats as allowed).
  public static string Check(Func<string, string> read) {
    if (read("hklm-all") == "Deny") return "blocked-all";
    if (read("hkcu-all") == "Deny") return "blocked-all";
    if (read("hkcu-desktop") == "Deny") return "blocked-desktop";
    return null;
  }

  public static string ReadRegistry(string key) {
    try {
      string root, path;
      switch (key) {
        case "hklm-all":
          root = "HKEY_LOCAL_MACHINE";
          path = @"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
          break;
        case "hkcu-all":
          root = "HKEY_CURRENT_USER";
          path = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
          break;
        case "hkcu-desktop":
          root = "HKEY_CURRENT_USER";
          path = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged";
          break;
        default:
          return null;
      }
      object value = Microsoft.Win32.Registry.GetValue(root + "\\" + path, "Value", null);
      return value as string;
    } catch (Exception) {
      return null;
    }
  }
}

public static class SplitpageVoice {
  static readonly object Gate = new object();
  static SplitpageVoiceGrace grace;
  static System.Diagnostics.Stopwatch clock;
  static System.Threading.Timer ticker;
  static System.Threading.Timer consentTicker;
  static string consentShown; // "blocked-all"/"blocked-desktop"/null, under Gate

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

  static SplitpageVoiceCapture capture;

  public static void List() {
    var b = new StringBuilder("{\"type\":\"microphones\",\"list\":[");
    string[][] found = SplitpageVoiceDevice.ActiveCapture();
    for (int i = 0; i < found.Length; i++) {
      if (i > 0) b.Append(',');
      b.Append("{\"id\":").Append(Json(found[i][0])).Append(",\"name\":").Append(Json(found[i][1])).Append('}');
    }
    lock (Gate) {
      Console.Out.WriteLine(b.Append("]}").ToString());
      Console.Out.Flush();
    }
  }

  public static SpeechRecognitionEngine Start(string wanted) {
    RecognizerInfo pick = Pick();
    if (pick == null) { Emit("error", "code", "no-recognizer"); return null; }
    var engine = new SpeechRecognitionEngine(pick);
    string mic = null;
    bool fellBack = false;
    if (!string.IsNullOrEmpty(wanted)) {
      mic = SplitpageVoiceDevice.ActiveCaptureName(wanted);
      if (mic == null) {
        fellBack = true;
      } else {
        capture = SplitpageVoiceCapture.Open(wanted);
        if (capture == null) {
          engine.Dispose();
          Emit("error", "code", "device-lost");
          return null;
        }
        engine.SetInputToAudioStream(capture.Input, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
      }
    }
    if (capture == null) {
      try {
        engine.SetInputToDefaultAudioDevice();
      } catch (InvalidOperationException) {
        engine.Dispose();
        Emit("error", "code", "audio-capture");
        return null;
      }
      mic = SplitpageVoiceDevice.DefaultCaptureName();
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
    if (capture != null) {
      capture.Level = level => Warn(() => level == 0 ? grace.Problem(Now(), "no-signal") : grace.Level(Now(), level));
      capture.Lost = Lost;
      capture.Start();
    }
    engine.RecognizeAsync(RecognizeMode.Multiple);
    if (fellBack) {
      lock (Gate) {
        Console.Out.WriteLine("{\"type\":\"fallback\"}");
        Console.Out.Flush();
      }
    }
    if (!string.IsNullOrEmpty(mic)) Emit("device", "name", mic);
    Emit("start", "lang", pick.Culture.Name);
    // no-signal is due by the clock, not by another event: the recogniser
    // may never raise it again after the first time.
    ticker = new System.Threading.Timer(_ => Warn(() => grace.Tick(Now())), null, 250, 250);
    // Blocked is certain the moment it's true, so it's checked once right
    // away (no grace period) and then every few seconds so turning the
    // setting back on clears the warning without pressing anything.
    CheckConsent();
    consentTicker = new System.Threading.Timer(_ => CheckConsent(), null, 3000, 3000);
    return engine;
  }

  static void CheckConsent() {
    string code = SplitpageVoiceConsent.Check(SplitpageVoiceConsent.ReadRegistry);
    lock (Gate) {
      if (code == consentShown) return;
      bool wasShown = consentShown != null;
      consentShown = code;
      if (code != null) Emit("warning", "code", code);
      else if (wasShown) Emit("warning", "code", "clear");
    }
  }

  public static void Stop() {
    if (capture != null) capture.Stop();
  }

  static void Lost() {
    Emit("error", "code", "device-lost");
    Stop();
    Environment.Exit(3);
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

  if ($List) {
    [SplitpageVoice]::List()
    exit 0
  }

  $engine = [SplitpageVoice]::Start($Device)
  if ($null -eq $engine) { exit 2 }

  # Block until main closes stdin. Everything heard in the meantime is written
  # by the C# handlers above, on the recogniser's threads.
  while ($null -ne [Console]::In.ReadLine()) { }

  [SplitpageVoice]::Stop()
  try { $engine.RecognizeAsyncCancel() } catch { }
  $engine.Dispose()
  exit 0
} catch {
  Write-Line '{"type":"error","code":"helper-failed"}'
  exit 1
}
