export var SpeechRecognitionCtor;

export function captureSpeechRecognition() {
  SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
