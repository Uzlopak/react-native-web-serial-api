import React from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type {SerialPort} from 'react-native-web-serial-api';
import {AppBar} from '../components/AppBar';
import {SingleChoiceDialog} from '../components/SingleChoiceDialog';
import {type ConnectionSettings, toSerialOptions} from '../settings';
import {colors} from '../theme';
import {
  applyTerminalLogOps,
  createTerminalLineBuffer,
  type TerminalLine,
  type TerminalLogOp,
  type TerminalSpan,
} from '../util/TerminalLineBuffer';
import * as TextUtil from '../util/TextUtil';

type Connected = 'False' | 'Pending' | 'True';
type SendBtnState = 'Idle' | 'Disabled';

const NEWLINES = [
  {label: 'CR+LF', value: TextUtil.NEWLINE_CRLF},
  {label: 'LF', value: TextUtil.NEWLINE_LF},
  {label: '<none>', value: ''},
];
const POLL_MS = 200;
const MAX_LINES = 2000;
const FLUSH_MS = 50;
const FOLLOW_TAIL_THRESHOLD_PX = 24;

type Props = {
  port: SerialPort;
  settings: ConnectionSettings;
  onBack: () => void;
};

export function TerminalScreen({port, settings, onBack}: Props) {
  const [logLines, setLogLines] = React.useState<TerminalLine[]>(
    () => createTerminalLineBuffer().lines,
  );
  const [input, setInput] = React.useState('');
  const [connected, setConnected] = React.useState<Connected>('False');
  // HEX mode is on by default (per product requirement).
  const [hexEnabled, setHexEnabled] = React.useState(true);
  const [newline, setNewline] = React.useState<string>(TextUtil.NEWLINE_CRLF);
  const [showControlLines, setShowControlLines] = React.useState(false);
  const [sendBtn, setSendBtn] = React.useState<SendBtnState>('Idle');
  const [lines, setLines] = React.useState({
    rts: false,
    cts: false,
    dtr: false,
    dsr: false,
    cd: false,
    ri: false,
  });
  const [newlineDialog, setNewlineDialog] = React.useState(false);

  // refs read by long-lived async loops / callbacks
  const connectedRef = React.useRef<Connected>('False');
  const hexRef = React.useRef(hexEnabled);
  const newlineRef = React.useRef(newline);
  const showCLRef = React.useRef(showControlLines);
  const settingsRef = React.useRef(settings);
  const pendingNewlineRef = React.useRef(false);
  const rtsRef = React.useRef(false);
  const dtrRef = React.useRef(false);
  const writerRef =
    React.useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readerRef =
    React.useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const logListRef = React.useRef<FlatList<TerminalLine>>(null);
  const logBufferRef = React.useRef(createTerminalLineBuffer());
  const logOpsRef = React.useRef<TerminalLogOp[]>([]);
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const followTailRef = React.useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);
  // Stable refs to the latest connect/teardown so the USB attach/detach
  // listeners (registered once) never call stale closures.
  const connectRef = React.useRef<(() => Promise<void>) | null>(null);
  const teardownRef = React.useRef<
    ((closePort: boolean) => Promise<void>) | null
  >(null);

  React.useEffect(() => {
    hexRef.current = hexEnabled;
  }, [hexEnabled]);
  React.useEffect(() => {
    newlineRef.current = newline;
  }, [newline]);
  React.useEffect(() => {
    showCLRef.current = showControlLines;
  }, [showControlLines]);
  React.useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const flushLogOps = React.useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (logOpsRef.current.length === 0) {
      return;
    }
    const ops = logOpsRef.current;
    logOpsRef.current = [];
    const next = applyTerminalLogOps(logBufferRef.current, ops, MAX_LINES);
    logBufferRef.current = next;
    setLogLines(next.lines);
  }, []);

  const queueLogOp = React.useCallback(
    (op: TerminalLogOp) => {
      logOpsRef.current.push(op);
      if (flushTimerRef.current) {
        return;
      }
      flushTimerRef.current = setTimeout(() => {
        flushLogOps();
      }, FLUSH_MS);
    },
    [flushLogOps],
  );

  const append = React.useCallback(
    (spans: TerminalSpan[]) => {
      queueLogOp({type: 'append', spans});
    },
    [queueLogOp],
  );

  const status = React.useCallback(
    (s: string) =>
      append([{text: `${s}\n`, color: colors.statusText, caret: false}]),
    [append],
  );

  // ported from TerminalFragment.receive()
  const receive = React.useCallback(
    (data: Uint8Array) => {
      if (hexRef.current) {
        append([
          {
            text: `${TextUtil.toHexString(data)}\n`,
            color: colors.receiveText,
            caret: false,
          },
        ]);
        return;
      }
      let msg = TextUtil.bytesToString(data);
      const nl = newlineRef.current;
      let dropCaret = false;
      if (nl === TextUtil.NEWLINE_CRLF && msg.length > 0) {
        // don't show CR as ^M directly before LF
        msg = msg.split('\r\n').join('\n');
        if (pendingNewlineRef.current && msg[0] === '\n') {
          dropCaret = true; // CR/LF arrived in separate chunks -> drop the "^M"
        }
        pendingNewlineRef.current = msg[msg.length - 1] === '\r';
      }
      const runs = TextUtil.toCaretRuns(msg, nl.length !== 0).map(r => ({
        text: r.text,
        color: colors.receiveText,
        caret: r.caret,
      }));
      if (dropCaret) {
        queueLogOp({type: 'dropTrailingCaretM'});
      }
      append(runs);
    },
    [append, queueLogOp],
  );

  const stopPoll = React.useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPoll = React.useCallback(() => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      if (connectedRef.current !== 'True') {
        return;
      }
      try {
        const sig = await port.getSignals();
        if (showCLRef.current) {
          setLines({
            rts: rtsRef.current,
            dtr: dtrRef.current,
            cts: sig.clearToSend,
            dsr: sig.dataSetReady,
            cd: sig.dataCarrierDetect,
            ri: sig.ringIndicator,
          });
        }
        if (settingsRef.current.flowControl === 'hardware') {
          setSendBtn(sig.clearToSend ? 'Idle' : 'Disabled');
        }
      } catch {
        // ignore transient signal read errors (e.g. mid-detach)
      }
    }, POLL_MS);
  }, [port, stopPoll]);

  const readLoop = React.useCallback(async () => {
    try {
      // Non-null: readLoop only runs after open() resolves, so readable is set.
      const reader = port.readable!.getReader();
      readerRef.current = reader;
      while (true) {
        const {value, done} = await reader.read();
        if (done) {
          break;
        }
        if (value?.length) {
          receive(value);
        }
      }
    } catch {
      // Read errors are handled by the disconnect listener / teardown.
    } finally {
      try {
        readerRef.current?.releaseLock();
      } catch {}
      readerRef.current = null;
    }
  }, [port, receive]);

  /**
   * Release this screen's reader/writer + poll loop. Idempotent. When
   * `closePort` is true (intentional leave) we also close the port; on a
   * physical detach the library has already reset the port, so we must NOT
   * touch the device (closePort=false) — that's what previously produced the
   * repeating "USB get_status request failed".
   */
  const teardown = React.useCallback(
    async (closePort: boolean) => {
      connectedRef.current = 'False';
      setConnected('False');
      stopPoll(); // stop control-line polling FIRST (no more control transfers)
      setSendBtn('Idle');
      try {
        if (readerRef.current) {
          await readerRef.current.cancel().catch(() => {});
        }
      } catch {}
      try {
        if (writerRef.current) {
          await writerRef.current.close().catch(() => {});
          writerRef.current.releaseLock();
        }
      } catch {}
      writerRef.current = null;
      if (closePort) {
        try {
          await port.close();
        } catch {}
      }
    },
    [port, stopPoll],
  );

  React.useEffect(() => {
    teardownRef.current = teardown;
  }, [teardown]);

  const connect = React.useCallback(async () => {
    // Idempotent: ignore overlapping triggers. On re-attach the device may emit
    // several "connect" events (USB attach + permission-grant), and port.open()
    // itself awaits the permission dialog — so guard against re-entrancy that
    // would otherwise cause a double-open ("port already open") and leave us
    // stuck in the failed/closed state.
    if (connectedRef.current !== 'False') {
      return;
    }
    connectedRef.current = 'Pending';
    setConnected('Pending');
    try {
      await port.open(toSerialOptions(settingsRef.current));
      connectedRef.current = 'True';
      setConnected('True');
      status('connected');
      // Non-null: writable is guaranteed set once open() has resolved.
      writerRef.current = port.writable!.getWriter();
      readLoop();
    } catch (e: any) {
      status(`connection failed: ${e?.message ?? e}`);
      connectedRef.current = 'False';
      setConnected('False');
    }
  }, [port, status, readLoop]);

  React.useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Connect on mount; close the port on unmount (intentional leave).
  React.useEffect(() => {
    connectRef.current?.();
    return () => {
      flushLogOps();
      teardownRef.current?.(true);
    };
  }, [flushLogOps]);

  // Physical detach / re-attach. The library fires these on the SAME SerialPort
  // instance (it re-associates the new Android deviceId on re-attach). We keep
  // the log across reconnects.
  React.useEffect(() => {
    const onDisconnect = () => {
      if (connectedRef.current === 'False') {
        return;
      }
      status('device disconnected');
      teardownRef.current?.(false);
    };
    const onReconnect = () => {
      status('reconnected');
      connectRef.current?.();
    };
    port.addEventListener('disconnect', onDisconnect);
    port.addEventListener('connect', onReconnect);
    return () => {
      port.removeEventListener('disconnect', onDisconnect);
      port.removeEventListener('connect', onReconnect);
    };
  }, [port, status]);

  // start/stop the control-line poll loop
  React.useEffect(() => {
    if (
      connected === 'True' &&
      (showControlLines || settings.flowControl !== 'none')
    ) {
      startPoll();
    } else {
      stopPoll();
    }
    if (settings.flowControl === 'none') {
      setSendBtn('Idle');
    }
  }, [connected, showControlLines, settings.flowControl, startPoll, stopPoll]);

  const onChangeInput = (t: string) =>
    setInput(hexRef.current ? TextUtil.formatHexInput(t) : t);

  const doSend = async () => {
    if (connectedRef.current !== 'True') {
      status('not connected');
      return;
    }
    let data: Uint8Array;
    let echo: string;
    if (hexRef.current) {
      const body = TextUtil.fromHexString(input);
      const nl = TextUtil.stringToBytes(newlineRef.current);
      data = new Uint8Array(body.length + nl.length);
      data.set(body, 0);
      data.set(nl, body.length);
      echo = TextUtil.toHexString(data);
    } else {
      echo = input;
      data = TextUtil.stringToBytes(input + newlineRef.current);
    }
    append([{text: `${echo}\n`, color: colors.sendText, caret: false}]);
    try {
      await writerRef.current?.write(data);
    } catch (e: any) {
      status(`write failed: ${e?.message ?? e}`);
    }
  };

  const toggleRts = async () => {
    if (connectedRef.current !== 'True') {
      status('not connected');
      return;
    }
    const v = !rtsRef.current;
    rtsRef.current = v;
    setLines(l => ({...l, rts: v}));
    try {
      await port.setSignals({requestToSend: v});
    } catch (e: any) {
      status(`setRTS failed: ${e?.message ?? e}`);
    }
  };

  const toggleDtr = async () => {
    if (connectedRef.current !== 'True') {
      status('not connected');
      return;
    }
    const v = !dtrRef.current;
    dtrRef.current = v;
    setLines(l => ({...l, dtr: v}));
    try {
      await port.setSignals({dataTerminalReady: v});
    } catch (e: any) {
      status(`setDTR failed: ${e?.message ?? e}`);
    }
  };

  const sendBreak = async () => {
    if (connectedRef.current !== 'True') {
      status('not connected');
      return;
    }
    try {
      await port.setSignals({break: true});
      await new Promise<void>(r => setTimeout(r, 100));
      status('send BREAK');
      await port.setSignals({break: false});
    } catch (e: any) {
      status(`send BREAK failed: ${e?.message ?? e}`);
    }
  };

  const toggleHex = () => {
    setHexEnabled(h => !h);
    setInput('');
  };

  const scrollToBottom = React.useCallback((animated: boolean) => {
    logListRef.current?.scrollToEnd({animated});
  }, []);

  const onLogScroll = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = e.nativeEvent;
      const atBottom =
        contentOffset.y + layoutMeasurement.height >=
        contentSize.height - FOLLOW_TAIL_THRESHOLD_PX;
      if (atBottom === followTailRef.current) {
        return;
      }
      followTailRef.current = atBottom;
      setShowJumpToBottom(!atBottom);
    },
    [],
  );

  const onLogContentSizeChange = React.useCallback(() => {
    if (followTailRef.current) {
      scrollToBottom(false);
    }
  }, [scrollToBottom]);

  const jumpToBottom = React.useCallback(() => {
    followTailRef.current = true;
    setShowJumpToBottom(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  const renderLogLine = React.useCallback(
    ({item}: {item: TerminalLine}) => (
      <Text style={styles.mono}>
        {item.spans.map((s, i) => (
          <Text
            key={`${item.id}-${i}`}
            style={[{color: s.color}, s.caret ? styles.caret : null]}>
            {s.text}
          </Text>
        ))}
      </Text>
    ),
    [],
  );

  const menu = [
    {
      key: 'clear',
      title: 'Clear',
      onPress: () => {
        queueLogOp({type: 'clear'});
      },
    },
    {key: 'newline', title: 'Newline', onPress: () => setNewlineDialog(true)},
    {
      key: 'hex',
      title: 'HEX Mode',
      checkable: true,
      checked: hexEnabled,
      onPress: toggleHex,
    },
    {
      key: 'controlLines',
      title: 'Control Lines',
      checkable: true,
      checked: showControlLines,
      onPress: () => setShowControlLines(s => !s),
    },
    {key: 'sendBreak', title: 'Send BREAK', onPress: sendBreak},
  ];

  const sendDisabled = connected !== 'True' || sendBtn === 'Disabled';

  return (
    <View style={styles.container}>
      <AppBar title="Simple USB Terminal" onBack={onBack} menu={menu} />

      {showControlLines ? (
        <View style={styles.controlLines}>
          <CtrlButton label="RTS" on={lines.rts} onPress={toggleRts} />
          <CtrlButton label="CTS" on={lines.cts} readOnly />
          <View style={styles.ctrlGap} />
          <CtrlButton label="DTR" on={lines.dtr} onPress={toggleDtr} />
          <CtrlButton label="DSR" on={lines.dsr} readOnly />
          <View style={styles.ctrlGap} />
          <CtrlButton label="CD" on={lines.cd} readOnly />
          <CtrlButton label="RI" on={lines.ri} readOnly />
        </View>
      ) : null}

      <View style={styles.divider} />

      <FlatList
        testID="terminal-log"
        ref={logListRef}
        data={logLines}
        keyExtractor={item => String(item.id)}
        renderItem={renderLogLine}
        style={styles.receive}
        contentContainerStyle={styles.receiveContent}
        onContentSizeChange={onLogContentSizeChange}
        onScroll={onLogScroll}
        scrollEventThrottle={16}
        initialNumToRender={40}
        maxToRenderPerBatch={64}
        updateCellsBatchingPeriod={16}
        windowSize={15}
        removeClippedSubviews
      />

      {showJumpToBottom ? (
        <TouchableOpacity
          style={styles.jumpToBottom}
          accessibilityLabel="Jump to bottom"
          onPress={jumpToBottom}>
          <Text style={styles.jumpToBottomText}>Jump to bottom</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.divider} />

      <View style={styles.sendRow}>
        <TextInput
          testID="terminal-input"
          style={styles.input}
          value={input}
          onChangeText={onChangeInput}
          placeholder={hexEnabled ? 'HEX mode' : ''}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          onSubmitEditing={doSend}
        />
        <TouchableOpacity
          testID="terminal-send"
          accessibilityLabel="Send"
          style={[styles.sendBtn, sendDisabled && styles.sendBtnDisabled]}
          onPress={doSend}
          disabled={sendDisabled}>
          <Text style={styles.sendIcon}>
            {sendBtn === 'Disabled' ? '⊘' : '➤'}
          </Text>
        </TouchableOpacity>
      </View>

      <SingleChoiceDialog
        visible={newlineDialog}
        title="Newline"
        options={NEWLINES}
        selected={newline}
        onSelect={setNewline}
        onClose={() => setNewlineDialog(false)}
      />
    </View>
  );
}

function CtrlButton({
  label,
  on,
  onPress,
  readOnly,
}: {
  label: string;
  on: boolean;
  onPress?: () => void;
  readOnly?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.ctrlBtn, on && styles.ctrlBtnOn]}
      onPress={onPress}
      disabled={readOnly}
      activeOpacity={readOnly ? 1 : 0.6}>
      <Text style={[styles.ctrlBtnText, readOnly && styles.ctrlBtnTextRo]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.background},
  controlLines: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
    flexWrap: 'wrap',
  },
  ctrlGap: {width: 8},
  ctrlBtn: {
    minWidth: 48,
    paddingVertical: 8,
    paddingHorizontal: 6,
    marginHorizontal: 2,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 4,
    alignItems: 'center',
  },
  ctrlBtnOn: {backgroundColor: colors.accent, borderColor: colors.accent},
  ctrlBtnText: {fontSize: 13, fontWeight: '600', color: colors.text},
  ctrlBtnTextRo: {color: colors.textSecondary},
  divider: {height: 2, backgroundColor: colors.divider},
  receive: {flex: 1, backgroundColor: colors.terminalBackground},
  receiveContent: {padding: 8, flexGrow: 1, justifyContent: 'flex-end'},
  mono: {
    fontFamily: 'monospace',
    fontSize: 13,
    color: colors.receiveText,
  },
  caret: {backgroundColor: colors.caretBackground},
  jumpToBottom: {
    position: 'absolute',
    right: 12,
    bottom: 64,
    backgroundColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 14,
  },
  jumpToBottomText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.background,
  },
  sendRow: {flexDirection: 'row', alignItems: 'center', padding: 4},
  input: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  sendBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {opacity: 0.35},
  sendIcon: {fontSize: 22, color: colors.primary},
});
