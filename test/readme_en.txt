FPVTrackside Extension Receive-Test Program
===========================================

server.js is a minimal program that receives the event JSON sent by
FPVTrackside (ExtensionMode = true) and just prints it to the console.


Requirements
------------
- Node.js (standard modules only; no npm install needed)


How to run
----------
  node server.js

On startup it prints:

  listening for FPVTrackside events on http://127.0.0.1:8765/

While it is running, set FPVTrackside's NotificationURL to
http://127.0.0.1:8765/ and enable ExtensionMode. Every received
event will then be printed to the console.


Changing the port
------------------
The default is 8765. To change it, set the PORT environment variable.

  Windows PowerShell:
    $env:PORT=9000; node server.js

  Windows Command Prompt:
    set PORT=9000 && node server.js

  macOS / Linux:
    PORT=9000 node server.js


Behavior
--------
Conforms to INTERFACE.en.md.

- Listens for HTTP PUT on 127.0.0.1:8765 (POST is also accepted)
- Always returns 200 OK (empty body) immediately, before processing
  the body (section 2.3)
- Then prints the received JSON to the console in this format:
    [HH:MM:SS.mmm] PUT /  type=<EventName> seq=<number>
    { pretty-printed JSON }
    ------------------------------------------------------------
- If the body cannot be parsed as JSON, the raw data is printed as-is


Notes
-----
Display only. It does not persist to config.json, detect seq/duplicate
events, or drive TTS/LED output. Intended for inspecting and debugging
received payloads.
