# StackChan local adapter

The adapter connects an existing StackChan MCP gateway to a paired Clowder AI Host.
The gateway process and the physical robot have separate readiness: `/health` reports
`offline` when the gateway responds but no ESP32 is connected, and `degraded` while
its hardware tools are undiscovered.

## Touch

- **Tap** opens the configured, bounded speech recognition window. After a successful
  listen it keeps looking up, ready for the reply.
- **Stroke** produces a gentle local head nuzzle, a happy expression, and dim pink
  ring lighting. It never records audio or emits a transcript.
- Failures restore the configured safe pose. Existing interaction IDs, durable
  observation retries, and duplicate suppression still apply.

## Owner-invoked play

Use the same absolute configuration file as the running adapter:

```sh
clowder-stackchan play status --config /absolute/path/to/adapter.json
clowder-stackchan play bicker --config /absolute/path/to/adapter.json
clowder-stackchan play dance --config /absolute/path/to/adapter.json
clowder-stackchan play stop --config /absolute/path/to/adapter.json
```

The owner command uses the paired adapter's local bearer credential. The loopback
`POST /play` endpoint accepts exactly `{ "scene": "bicker" | "dance" | "stop" }`.
It accepts no arbitrary gateway commands, sensor uploads, text, or unbounded duration.
The robot must be connected before a new scene begins.

`bicker` performs a short, explicitly scripted three-cat exchange: distinct configured
voices, generic robot expressions, dim ring colors, and turns within ±18° yaw.
It requires `xianxian:local`, `shuosh:local`, and `yanyan:local` voice profiles in the
existing `voiceProfiles` configuration. These are scripted lines rather than live
model replies; custom cat face packs are not installed by this command.

`dance` uses the existing gateway beat engine for 20 seconds, with low motion
intensity. It uses the robot microphone for local beat analysis. It does not upload
or save audio. The adapter always requests microphone release when the scene ends.
Touch or an incoming physical action interrupts play before starting the interaction.
`stop` cancels the remaining scene, releases beat capture, clears lights, and returns
the head to the configured safe pose without muting the ordinary speaker. The
gateway serializes hardware commands and offers no separate speech interruption
tool: an already-started short line may finish before the stop commands execute.
A scene also has a 45-second deadline. The original scene reports its failures;
they do not prevent a subsequent touch or physical action from attempting recovery.

The plugin needs a gateway/firmware with the named motion, avatar, LED, speech,
and beat tools. A tool appearing in the gateway catalog alone does not prove that
a particular flashed robot implements it. Camera appraisal, face tracking,
manual torque control, desktop screen capture, and live chat broadcasting are
not implemented by these play scenes.

These source changes do not publish a new npm or catalog release.
