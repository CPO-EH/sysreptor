import { get, set, unset, throttle, trimStart, sortBy, cloneDeep } from "lodash-es";
import { urlJoin } from "@base/utils/helpers";
import { ChangeSet, EditorSelection, SelectionRange, Text } from "@sysreptor/markdown/editor"
import { CommentStatus, type Comment, type UserShortInfo } from "#imports"

const WS_THROTTLE_INTERVAL = 1_000;
const WS_RESPONSE_TIMEOUT = 7_000;
const WS_PING_INTERVAL = 30_000;
const HTTP_THROTTLE_INTERVAL = 5_000;
const HTTP_FALLBACK_INTERVAL = 10_000;

export enum CollabEventType {
  CONNECT = 'collab.connect',
  DISCONNECT = 'collab.disconnect',
  INIT = 'collab.init',
  CREATE = 'collab.create',
  UPDATE_KEY = 'collab.update_key',
  UPDATE_TEXT = 'collab.update_text',
  DELETE = 'collab.delete',
  SORT = 'collab.sort',
  AWARENESS = 'collab.awareness',
  ERROR = 'error',
  PING = 'ping',
};

export type TextUpdate = {
  changes: ChangeSet;
  selection?: EditorSelection;
}

export type CollabClientInfo = {
  client_id: string;
  client_color: string;
  user?: UserShortInfo|null;
}

export type CollabEvent = {
  type: CollabEventType;
  path: string|null;
  version?: number;
  client_id?: string;
  value?: any;
  updates?: (TextUpdate|{ changes: any; seletion?: any; })[];
  selection?: any;
  update_awareness?: boolean;
  sort?: { id: string, order: number }[];
  data?: any;
  comments?: Partial<Comment>[];
  client?: CollabClientInfo;
  clients?: CollabClientInfo[];
  permissions?: {
    read: boolean;
    write: boolean;
  }
}

export enum CollabConnectionType {
  WEBSOCKET = 'websocket',
  HTTP_FALLBACK = 'http_fallback',
  HTTP_READONLY = 'http_readonly',
};

export enum CollabConnectionState {
  CLOSED = 'closed',
  CONNECTING = 'connecting',
  OPEN = 'open',
};

export type CollabConnectionInfo = {
  type: CollabConnectionType;
  connectionState: CollabConnectionState;
  connectionConfig: {
    throttleInterval: number;
  },
  connectionError?: { error: any, message?: string };
  connectionAttempt?: number;
  sendThrottled?: ReturnType<typeof throttle>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  send: (events: CollabEvent[]) => void;
};

export type AwarenessInfos = {
  self: {
    path: string|null;
    selection?: EditorSelection;
  };
  other: Record<string, {
    path: string|null;
    selection?: EditorSelection;
  }>;
  clients: CollabClientInfo[];
}

export type CollabStoreState<T> = {
  data: T & { 
    comments?: Record<string, Comment> 
  };
  apiPath: string;
  connection?: CollabConnectionInfo;
  handleAdditionalWebSocketMessages?: (event: CollabEvent, collabState: CollabStoreState<T>) => boolean;
  perPathState: Map<string, {
    pendingEvents: CollabEvent[];
    unconfirmedTextUpdates: TextUpdate[];
  }>;
  awareness: AwarenessInfos,
  permissions: {
    read: boolean;
    write: boolean;
  },
  version: number;
  clientID: string;
  search: string|null;
}

export function makeCollabStoreState<T>(options: {
  apiPath: string, 
  initialData: T & {
    comments?: Record<string, Comment>
  },
  initialPath?: string,
  handleAdditionalWebSocketMessages?: (event: CollabEvent, storeState: CollabStoreState<T>) => boolean
}): CollabStoreState<T> {
  return {
    data: options.initialData,
    apiPath: options.apiPath,
    handleAdditionalWebSocketMessages: options.handleAdditionalWebSocketMessages,
    perPathState: new Map(),
    awareness: {
      self: {
        path: options.initialPath || '',
      },
      other: {},
      clients: [],
    },
    permissions: {
      read: true,
      write: true,
    },
    version: 0,
    clientID: '',
    search: '',
  }
}

function isSubpath(subpath?: string|null, parent?: string|null) {
  if (!subpath || !parent) {
    return false;
  }
  return subpath === parent || subpath.startsWith(parent + (!parent.endsWith('/') ? '.' : ''));
}

async function sendEventsHttp<T>(storeState: CollabStoreState<T>, messages?: CollabEvent[]) {
  messages = Array.from(messages || []);

  return await $fetch<{ version: number, messages: CollabEvent[], clients: CollabClientInfo[] }>(urlJoin(storeState.apiPath, '/fallback/'), { 
    method: 'POST', 
    body: {
      version: storeState.version,
      client_id: storeState.clientID,
      messages,
    }
  });
}

export function connectionWebsocket<T = any>(storeState: CollabStoreState<T>, onReceiveMessage: (msg: CollabEvent) => void) {
  const serverUrl = `${window.location.protocol === 'http:' ? 'ws' : 'wss'}://${window.location.host}/`;
  const wsUrl = urlJoin(serverUrl, storeState.apiPath);
  const websocket = ref<WebSocket|null>(null);

  const connectionInfo = reactive<CollabConnectionInfo>({
    type: CollabConnectionType.WEBSOCKET,
    connectionState: CollabConnectionState.CLOSED,
    connectionError: undefined,
    connectionConfig: {
      throttleInterval: WS_THROTTLE_INTERVAL,
    },
    connect,
    disconnect,
    send,
  });

  const websocketPingInterval = useIntervalFn(websocketSendPing, WS_PING_INTERVAL, { immediate: false });
  const websocketResponseTimeout = throttle(() => {
    // Possible reasons: network outage, browser tab becomes inactive, server crashes
    if (websocket.value && ![WebSocket.CLOSED, WebSocket.CLOSING].includes(websocket.value?.readyState as any)) {
      websocket.value?.close(4504, 'Connection loss detection timeout');
    }
  }, WS_RESPONSE_TIMEOUT, { leading: false, trailing: true });

  async function connect() {
    return await new Promise<void>((resolve, reject) => {
      if (connectionInfo.connectionState !== CollabConnectionState.CLOSED) {
        resolve();
        return;
      }

      connectionInfo.connectionState = CollabConnectionState.CONNECTING;
      websocket.value = new WebSocket(wsUrl);
      websocket.value.addEventListener('open', () => {
        websocketPingInterval.resume();
      })
      websocket.value.addEventListener('close', (event) => {
        // Error handling
        if (event.code === 4443) {
          connectionInfo.connectionError = { error: event, message: event.reason || 'Permission denied' };
        } else if (connectionInfo.connectionState === CollabConnectionState.CONNECTING) {
          connectionInfo.connectionError = { error: event, message: event.reason || 'Failed to establish connection' };
        } else if (event.code === 1012) {
          connectionInfo.connectionError = { error: event, message: event.reason || 'Server worker process is restarting' };
        } else if (event.code !== 1000) {
          connectionInfo.connectionError = { error: event, message: event.reason };
        }
        // eslint-disable-next-line no-console
        console.log('Websocket closed', event, toValue(connectionInfo.connectionError));
        
        // Reset data
        websocket.value = null;
        websocketPingInterval.pause();
        websocketResponseTimeout.cancel();
        connectionInfo.connectionState = CollabConnectionState.CLOSED;

        reject(connectionInfo.connectionError);
      });
      websocket.value.addEventListener('message', (event: MessageEvent) => {
        const msgData = JSON.parse(event.data) as CollabEvent;

        // Reset connection loss detection
        websocketResponseTimeout?.cancel();
        
        // Handle message
        onReceiveMessage(msgData);

        // Promise result
        if (msgData.type === CollabEventType.INIT) {
          connectionInfo.connectionState = CollabConnectionState.OPEN;
          resolve();
        }
      });
    });
  }

  async function disconnect() {
    if ([WebSocket.CLOSED, WebSocket.CLOSING].includes(websocket.value?.readyState as any)) {
      return;
    }

    if (websocket.value?.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        websocket.value?.addEventListener('close', () => resolve(), { once: true });
        websocket.value?.close(1000, 'Disconnect'); 
      });
    }
  }

  function send(events: CollabEvent[]) {
    for (const msg of events) {
      websocketSend(msg);
    }
  }

  function websocketSend(msg: CollabEvent) {
    if (websocket.value?.readyState !== WebSocket.OPEN) {
      return;
    }
    websocket.value?.send(JSON.stringify(msg));
    websocketResponseTimeout();
  }

  async function websocketSendPing() {
    websocketSend({ 
      type: CollabEventType.PING,
      version: storeState.version,
      path: null,
    });
  }

  return connectionInfo;
}

export function connectionHttpFallback<T = any>(storeState: CollabStoreState<T>, onReceiveMessage: (msg: CollabEvent) => void) {
  const httpUrl = urlJoin(storeState.apiPath, '/fallback/');
  const connectionInfo = reactive<CollabConnectionInfo>({
    type: CollabConnectionType.HTTP_FALLBACK,
    connectionConfig: {
      throttleInterval: HTTP_THROTTLE_INTERVAL,
    },
    connectionState: CollabConnectionState.CLOSED,
    connectionError: undefined,
    connect,
    disconnect,
    send,
  });
  const fetchInterval = useIntervalFn(() => sendAndReceiveMessages([]), HTTP_FALLBACK_INTERVAL, { immediate: false });

  async function connect() {
    connectionInfo.connectionState = CollabConnectionState.CONNECTING;
    try {
      const res = await $fetch<CollabEvent>(httpUrl, { method: 'GET' });
      onReceiveMessage(res);
      connectionInfo.connectionState = CollabConnectionState.OPEN;

      fetchInterval.resume();
    } catch (error) {
      connectionInfo.connectionError = { error };
      connectionInfo.connectionState = CollabConnectionState.CLOSED;
      throw error;
    }
  }

  async function disconnect() {
    fetchInterval.pause();
    connectionInfo.connectionState = CollabConnectionState.CLOSED;
  }

  function send(events: CollabEvent[]) {
    // Do not send awareness and ping event at all.
    events = events.filter(e => ![CollabEventType.AWARENESS, CollabEventType.PING].includes(e.type));
    if (events.length === 0) {
      return;
    }

    // Reset fetch interval because sendMessages also fetches server events since last update
    fetchInterval.pause();
    fetchInterval.resume();

    sendAndReceiveMessages(events);
  }

  async function sendAndReceiveMessages(events?: CollabEvent[]) {
    try {
      const res = await sendEventsHttp(storeState, events || []);
      
      storeState.version = res.version;
      storeState.awareness.clients = res.clients;
      for (const m of res.messages) {
        onReceiveMessage(m);
      }
    } catch (error) {
      // Disconnect on error
      connectionInfo.connectionError = { error };
      disconnect();
    }
  }

  return connectionInfo;
}

export function connectionHttpReadonly<T = any>(storeState: CollabStoreState<T>, onReceiveMessage: (msg: CollabEvent) => void) {
  const httpUrl = urlJoin(storeState.apiPath, '/fallback/');
  const connectionInfo = reactive<CollabConnectionInfo>({
    type: CollabConnectionType.HTTP_READONLY,
    connectionState: CollabConnectionState.CLOSED,
    connectionError: undefined,
    connectionConfig: {
      throttleInterval: HTTP_THROTTLE_INTERVAL,
    },
    connect,
    disconnect: () => Promise.resolve(),
    send: () => {},
  });

  async function connect() {
    connectionInfo.connectionState = CollabConnectionState.CONNECTING;
    try {
      const res = await $fetch<CollabEvent>(httpUrl, { method: 'GET' });
      onReceiveMessage(res);
      connectionInfo.connectionState = CollabConnectionState.OPEN;
    } catch (e) {
      connectionInfo.connectionError = { error: e };
      connectionInfo.connectionState = CollabConnectionState.CLOSED;
      throw e;
    }
  }

  return connectionInfo;
}

export function useCollab<T = any>(storeState: CollabStoreState<T>) {
  const apiSettings = useApiSettings();
  const eventBusBeforeApplyRemoteTextChange = useEventBus('collab:beforeApplyRemoteTextChanges');
  const eventBusBeforeApplySetValue = useEventBus('collab:beforeApplySetValue');

  async function connectTo(connection: CollabConnectionInfo) {
    storeState.version = 0;
    storeState.perPathState?.clear();
    storeState.awareness = {
      self: { path: storeState.awareness.self.path },
      other: {},
      clients: [],
    };
    storeState.connection?.sendThrottled?.cancel();

    try {
      connection.sendThrottled = throttle(sendPendingMessages, connection.connectionConfig.throttleInterval, { leading: false, trailing: true });
      await connection.connect();
      storeState.connection = connection;
    } catch (error) {
      connection.sendThrottled?.cancel();
      connection.sendThrottled = undefined;
      throw error;
    }
  }

  async function connect(options?: { connectionType?: CollabConnectionType }) {
    if (storeState.connection && storeState.connection.connectionState !== CollabConnectionState.CLOSED) {
      return;
    }

    if (options?.connectionType === CollabConnectionType.HTTP_READONLY) {
      // HTTP read only connection
      storeState.connection = connectionHttpReadonly(storeState, onReceiveMessage);
      return await storeState.connection?.connect();
    } else {
      // If there are pending events from the previous connection, send them now to prevent losing events.
      // Try to sync as many changes as possible. When some events cannot be processed, we don't care since we cannot handle them anyway.
      try {
        const pendingEvents = getPendingEvents({ clearPending: false, includeAwareness: false });
        if (storeState.version > 0 && pendingEvents.length > 0) {
            await sendEventsHttp(storeState, pendingEvents);
        }
      } catch {
        // Ignore errors. If data is saved: good, if not: discard it (there's most likely a error or conflict in it)
      }

      // Dummy connection info with connectionState=CONNECTING
      storeState.connection = {
        type: CollabConnectionType.WEBSOCKET,
        connectionState: CollabConnectionState.CONNECTING,
        connectionConfig: {
          throttleInterval: 1_000,
        },
        connectionAttempt: 0,
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        send: () => {},
      };

      // Try websocket connection first
      if (apiSettings.settings!.features.websockets) {
        for (let i = 0; i < 2; i++) {
          try {
            return await connectTo(connectionWebsocket(storeState, onReceiveMessage));
          } catch {
            // Increment reconnection attempt counter
            storeState.connection!.connectionAttempt = (storeState.connection!.connectionAttempt || 0) + 1;

            // Backoff time for reconnecting
            if (i === 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }
      }

      // Fallback to HTTP polling
      const fallbackConnection = connectionHttpFallback(storeState, onReceiveMessage);
      try {
        return await connectTo(fallbackConnection);
      } catch (e) {
        storeState.connection = fallbackConnection;
        throw e;
      }
    }
  }

  async function disconnect() {
    const con = storeState.connection;
    if (con?.sendThrottled) {
      // Flush pending events
      con.sendThrottled();
      con.sendThrottled.flush();
      con.sendThrottled = undefined;
    }
    await con?.disconnect();
    if (storeState.connection === con) {
      storeState.connection = undefined;
    }
  }

  function onReceiveMessage(msgData: CollabEvent) {  
    try {
      if (msgData.version && msgData.version > storeState.version) {
        storeState.version = msgData.version;
      }
      
      if (storeState.handleAdditionalWebSocketMessages?.(msgData, storeState)) {
        // Already handled
      } else if (msgData.type === CollabEventType.INIT) {
        storeState.data = msgData.data;
        storeState.clientID = msgData.client_id!;
        storeState.permissions = msgData.permissions!;
        storeState.awareness.clients = msgData.clients!;
        storeState.awareness.other = Object.fromEntries(msgData.clients!.filter((c: any) => c.client_id !== storeState.clientID).map((c: any) => [c.client_id, { 
          path: c.path, 
          selection: undefined, 
        }]));

        // Send awareness
        sendAwarenessThrottled();
      } else if (msgData.type === CollabEventType.UPDATE_KEY) {
        if (msgData.client_id !== storeState.clientID) {
          setValue(msgData.path!, msgData.value);
        }
        updateComments({ comments: msgData.comments });
      } else if (msgData.type === CollabEventType.UPDATE_TEXT) {
        receiveUpdateText(msgData);
      } else if (msgData.type === CollabEventType.CREATE) {
        setValue(msgData.path!, msgData.value);
      } else if (msgData.type === CollabEventType.DELETE) {
        const pathParts = msgData.path!.split('.');
        const parentPath = pathParts.slice(0, -1).join('.');
        const parentList = get(storeState.data as object, parentPath);
        const parentListIndex = Number.parseInt(pathParts.slice(-1)?.[0]?.startsWith('[') ? pathParts.slice(-1)[0]!.slice(1, -1) : '');
                
        if (Array.isArray(parentList) && !Number.isNaN(parentListIndex)) {
          const parentListNew = parentList.filter((_, idx) => idx !== parentListIndex);
          setValue(parentPath, parentListNew);
        } else {
          unset(storeState.data as object, msgData.path!);
        }
        removeInvalidSelections(parentPath);
        updateComments({ comments: msgData.comments });
      } else if (msgData.type === CollabEventType.CONNECT) {
        if (msgData.client_id !== storeState.clientID) {
          // Add new client
          storeState.awareness.clients.push(msgData.client!);
        }

        // Send awareness
        sendAwarenessThrottled();
      } else if (msgData.type === CollabEventType.DISCONNECT) {
        // Remove client
        storeState.awareness.clients = storeState.awareness.clients
          .filter(c => c.client_id !== msgData.client_id);
        delete storeState.awareness.other[msgData.client_id!];
      } else if (msgData.type === CollabEventType.AWARENESS) {
        if (msgData.client_id !== storeState.clientID) {
          storeState.awareness.other[msgData.client_id!] = {
            path: msgData.path,
            selection: msgData.path ? parseSelection({
              selectionJson: msgData.selection, 
              unconfirmed: storeState.perPathState.get(msgData.path)?.unconfirmedTextUpdates || [], 
              text: get(storeState.data as object, msgData.path) || ''
            }) : undefined,
          };
        }
      } else if (msgData.type === CollabEventType.ERROR) {
        // eslint-disable-next-line no-console
        console.error('Received error from websocket:', msgData);
      } else if (msgData.type === CollabEventType.PING) {
        // Do nothing
      } else {
        throw new Error('Unknown collab event type: ' + msgData?.type);
      }
    } catch (error) {
      handleCollabError(msgData, error);
    }
  }

  function toDataPath(path: string) {
    return trimStart(path.slice(storeState.apiPath.length), '.');
  }

  function ensurePerPathState(path: string) {
    if (!storeState.perPathState.has(path)) {
      storeState.perPathState.set(path, {
        pendingEvents: [],
        unconfirmedTextUpdates: [],
      });
    }
    return storeState.perPathState.get(path)!;
  }

  function getPendingEvents(options?: { clearPending?: boolean, includeAwareness?: boolean }) {
    const events = [];
    let sendAwarenessEvent = null as boolean|null;
    for (const [p, s] of storeState.perPathState.entries()) {
      const appendEvents = [];
      
      // Collect non-text events
      for (const e of s.pendingEvents) {
        if (e.type === CollabEventType.AWARENESS) {
          if (sendAwarenessEvent === null) {
            sendAwarenessEvent = true;
          }
        } else if(e.type === CollabEventType.UPDATE_TEXT) {
          // Handle below
        } else if ([CollabEventType.CREATE, CollabEventType.DELETE].includes(e.type)) {
          // Handle events last
          appendEvents.push({
            ...e,
            version: storeState.version,
          });
        } else {
          let update_awareness = false;
          if (e.update_awareness && e.path === storeState.awareness.self.path) {
            update_awareness = true;
            // Do not send awareness separately
            sendAwarenessEvent = false;
          }
          events.push({
            ...e,
            version: storeState.version,
            update_awareness,
          });
        }
      }
      
      // Collect text updates
      if (s.unconfirmedTextUpdates.length > 0) {
        let selection;
        if (storeState.awareness.self.path === p) {
          // Awareness info is included in update_text message
          // No need to send it separately
          selection = storeState.awareness.self.selection?.toJSON();
          // Do not send awareness separately because informations are included in update_text
          sendAwarenessEvent = false;   
        }

        events.push({
          type: CollabEventType.UPDATE_TEXT,
          path: p,
          version: storeState.version,
          updates: s.unconfirmedTextUpdates.map(u => ({ changes: u.changes.toJSON() })),
          selection,
        })
      }

      events.push(...appendEvents);

      // Clear pending events that will be sent
      if (options?.clearPending) {
        s.pendingEvents = [];
      }
    }

    // Send awareness event
    if (options?.includeAwareness && sendAwarenessEvent) {
      events.push({
        type: CollabEventType.AWARENESS,
        path: storeState.awareness.self.path,
        version: storeState.version,
        selection: storeState.awareness.self.selection?.toJSON(),
      });
    }

    return events;
  }

  function sendPendingMessages() {
    const events = getPendingEvents({ clearPending: true, includeAwareness: true });
    if (events.length > 0) {
      storeState.connection?.send(events);
    }
  }

  function sendEventsThrottled(...events: CollabEvent[]) {
    for (const e of events) {
      ensurePerPathState(e.path!).pendingEvents.push(e);
    }
    storeState.connection?.sendThrottled?.();
  }

  function sendEventsImmediately(...events: CollabEvent[]) {
    sendEventsThrottled(...events);
    storeState.connection?.sendThrottled?.flush();
  }

  function sendAwarenessThrottled() {
    if (!storeState.permissions.write) {
      return;
    }

    sendEventsThrottled({
      type: CollabEventType.AWARENESS,
      path: storeState.awareness.self.path,
      version: storeState.version,
      selection: storeState.awareness.self.selection?.toJSON(),
    });
  }

  function updateKey(event: any) {
    // Update local state
    const dataPath = toDataPath(event.path);
    setValue(dataPath, event.value);

    // Update awareness
    if (event.updateAwareness) {
      storeState.awareness.self = {
        path: dataPath,
        selection: undefined,
      };
    }

    // Propagate event to other clients
    sendEventsThrottled({
      type: event.type || CollabEventType.UPDATE_KEY,
      path: dataPath,
      version: storeState.version,
      value: event.value,
      update_awareness: event.updateAwareness,
      sort: event.sort,
    });
  }

  function createListItem(event: any) {
    // Do not update local state here. Wait for server event.
    // Propagate event to other clients
    const dataPath = toDataPath(event.path);
    sendEventsImmediately({
      type: CollabEventType.CREATE,
      path: dataPath,
      version: storeState.version,
      value: event.value,
    });
  }

  function deleteListItem(event: any) {
    // Do not update local state here. Wait for server event.
    // Propagate event to other clients
    const dataPath = toDataPath(event.path);
    sendEventsImmediately({
      type: CollabEventType.DELETE,
      path: dataPath,
      version: storeState.version,
    });
  }

  function updateText(event: any) {
    const dataPath = toDataPath(event.path);
    const perPathState = ensurePerPathState(dataPath);

    // Update local state
    const text = get(storeState.data as object, dataPath) || '';
    let cmText = Text.of(text.split(/\r?\n/));
    let selection = storeState.awareness.self.path === dataPath ? storeState.awareness.self.selection : undefined;

    let composedChanges = null as ChangeSet|null;
    for (const u of perPathState.unconfirmedTextUpdates) {
      composedChanges = composedChanges ? composedChanges.compose(u.changes) : u.changes;
    }

    for (const u of event.updates) {
      // Apply text changes
      cmText = u.changes.apply(cmText);
      // Update local selection
      try {
        selection = selection?.map(u.changes);
      } catch {
        selection = undefined;
      }

      // Map selections of other clients onto changes
      for (const a of Object.values(storeState.awareness.other)) {
        if (a.path === dataPath) {
          try {
            a.selection = a.selection?.map(u.changes);
          } catch {
            a.selection = undefined;
          }
        }
      }

      // Map comment positions
      const comments = Object.values(storeState.data.comments || {});
      for (const c of comments) {
        if (c.path === dataPath && c.text_range) {
          let pos: SelectionRange|null = SelectionRange.fromJSON({ anchor: c.text_range.from, head: c.text_range.to });
          try {
            pos = pos.map(u.changes);
            if (pos.empty) {
              pos = null;
            }
          } catch {
            pos = null;
          }
          c.text_range = pos;
        }
      }
      
      // Check if changes can be composed with previous unconfirmed updates
      composedChanges = composedChanges ? composedChanges.compose(u.changes) : u.changes;
    }
    // Update text
    set(storeState.data as object, dataPath, cmText.toString());

    // Update awareness
    storeState.awareness.self = {
      path: dataPath,
      selection,
    };

    // Track unconfirmed changes
    perPathState.unconfirmedTextUpdates.push(...event.updates.map((u: any) => ({
      changes: u.changes,
    })));

    // Propagate unconfirmed events to other clients
    sendEventsThrottled();
  }

  function setValue(path: string, value: any) {
    // Clear pending updates, because they are overwritten by the value of collab.update_key
    for (const [k, v] of storeState.perPathState.entries()) {
      if (isSubpath(k, path)) {
        v.unconfirmedTextUpdates = [];
        v.pendingEvents = [];
      }
    }

    function emitBeforeApplySetValue(subpath: string, subvalue: any) {
      eventBusBeforeApplySetValue.emit({
        path: storeState.apiPath + subpath,
        value: subvalue,
      });

      if (Array.isArray(subvalue)) {
        for (let i = 0; i < subvalue.length; i++) {
          emitBeforeApplySetValue(`${subpath}.[${i}]`, subvalue[i]);
        }
      } else if (subvalue && typeof subvalue === 'object') {
        for (const [k, v] of Object.entries(subvalue)) {
          emitBeforeApplySetValue(`${subpath}.${k}`, v);
        }
      }
    }
    emitBeforeApplySetValue(path, value);

    // Update local state
    set(storeState.data as object, path!, value);
    removeInvalidSelections(path!);
  }

  function updateAwareness(event: any) {
    if (event.focus === false && event.path !== storeState.awareness.self.path) {
      // On focus other field: do not propagate unfocus event
      return;
    }

    const dataPath = toDataPath(event.path);
    if (storeState.awareness.self.path !== dataPath || storeState.awareness.self.selection !== event.selection) {
      storeState.awareness.self = {
        path: dataPath,
        selection: event.selection,
      };
      sendAwarenessThrottled();
    }
  }

  function receiveUpdateText(event: any) {
    const perPathState = ensurePerPathState(event.path);
    let changes: ChangeSet|null = null;
    let own = 0;
    for (const update of event.updates.map((u: any) => ({ changes: ChangeSet.fromJSON(u.changes) }))) {
      const ours = own < perPathState.unconfirmedTextUpdates.length ? perPathState.unconfirmedTextUpdates[own] : null;
      if (ours && storeState.clientID === event.client_id) {
        if (changes) {
          changes = changes.map(ours.changes, true);
        }
        own++;
      } else {
        changes = changes ? changes.compose(update.changes) : update.changes;
      }
    }

    let unconfirmed = perPathState.unconfirmedTextUpdates.slice(own)
    if (unconfirmed.length > 0) {
      if (changes) {
        unconfirmed = unconfirmed.map((update: any) => {
          const updateChanges = update.changes.map(changes!);
          changes = changes!.map(update.changes, true);
          return {
            changes: updateChanges,
          };
        });
      }
    }

    // Update store
    perPathState.unconfirmedTextUpdates = unconfirmed;

    if (changes) {
      // Send an event to the active markdown editor to apply changes before updating store state.
      // This allows the markdown editor to annotate the changes as remote change and handle it differently from local changes.
      // e.g. not add it to its local history to be able to only undo local changes, not remote changes of other users.
      eventBusBeforeApplyRemoteTextChange.emit({
        path: storeState.apiPath + event.path,
        changes,
      })

      // Apply changes to store state
      const text = get(storeState.data as object, event.path) || '';
      let cmText = Text.of(text.split(/\r?\n/));
      cmText = changes.apply(cmText);
      set(storeState.data as object, event.path, cmText.toString());

      // Update local selection
      if (storeState.awareness.self.path === event.path) {
        storeState.awareness.self.selection = storeState.awareness.self.selection?.map(changes);
      }

      // Update comments
      updateComments({ 
        comments: event.comments, 
        unconfirmed,
        text,
      });
      
      // Update remote selections
      for (const [clientId, a] of Object.entries(storeState.awareness.other)) {
        if (event.client_id === clientId) {
          a.path = event.path;
          if (event.selection) {
            a.selection = parseSelection({
              selectionJson: event.selection,
              unconfirmed,
              text: cmText,
            });
          }
        } else if (a.path === event.path) {
          a.selection = a.selection?.map(changes);
        }
      }
    }
  }

  function parseSelection(options: {selectionJson: any|undefined, unconfirmed: TextUpdate[], text: Text|string}) {
    if (!options.selectionJson) {
      return undefined;
    }
    try {
      let selection = EditorSelection.fromJSON(options.selectionJson);
      // Rebase selection onto unconfirmed changes
      for (const u of options.unconfirmed) {
        selection = selection.map(u.changes);
      }
      // Validate selection ranges are valid text positions
      for (const r of selection.ranges) {
        if (!(r.from >= 0 && r.to <= options.text.length)) {
          return undefined;
        }
      }
      return selection;
    } catch {
      return undefined;
    }
  }

  function removeInvalidSelections(path?: string) {
    // Filter out invalid selections of current field and child fields
    for (const a of [storeState.awareness.self].concat(Object.values(storeState.awareness.other))) {
      if (a.path && (!path || isSubpath(a.path, path)) && a.selection) {
        const text = get(storeState.data as object, a.path);
        if (typeof text !== 'string' || !a.selection.ranges.every(r => r.from >= 0 && r.to <= (text || '').length)) {
          a.selection = undefined;
        }
      }
    }
  }

  function updateComments(options: { comments?: Partial<Comment>[], unconfirmed?: TextUpdate[], text?: Text|string }) {
    const commentsStoreState = storeState.data.comments;
    if (!options.comments || !commentsStoreState) {
      return;
    }

    for (const c of options.comments) {
      if (c.id! in commentsStoreState) {
        if (c.path === null) {
          // Delete comment
          delete commentsStoreState[c.id!];
          continue;
        }
        
        if (c.text_range && options.unconfirmed) {
          try {
            let pos: SelectionRange|null = SelectionRange.fromJSON({ anchor: c.text_range.from, head: c.text_range.to });
            for (const u of options.unconfirmed) {
              pos = pos.map(u.changes);
            }
            if ((options.text !== undefined && !(pos.from >= 0 && pos.to <= options.text.length)) || pos.empty) {
              pos = null;
            }

            c.text_range = pos;
          } catch {
            c.text_range = null;
          }
        }
        Object.assign(commentsStoreState[c.id!]!, c);
      }
    }
  }

  function handleCollabError(event: any, error: any) {
    const dataPath = toDataPath(event.path);
    // eslint-disable-next-line no-console
    console.error('Error while processing collab event:', { 
      error, 
      event, 
      version: storeState.version,
      fieldValue: cloneDeep(get(storeState.data as object, dataPath)),
      perPathState: cloneDeep(storeState.perPathState.get(dataPath)),
    });
    if (storeState.connection) {
      storeState.connection.connectionError = { error };
      disconnect();
    }
  }

  function onCollabEvent(event: any) {
    if (!event.path?.startsWith(storeState.apiPath)) {
      // Event is not for us
      return;
    } else if (!storeState.permissions.write) {
      return;
    }

    try {
      if (event.type === CollabEventType.UPDATE_KEY) {
        updateKey(event);
      } else if (event.type === CollabEventType.UPDATE_TEXT) {
        updateText(event);
      } else if (event.type === CollabEventType.CREATE) {
        createListItem(event);
      } else if (event.type === CollabEventType.DELETE) {
        deleteListItem(event);
      } else if (event.type === CollabEventType.AWARENESS) {
        updateAwareness(event);
      } else {
        throw new Error('Unknown collab event type');
      }
    } catch (error) {
      handleCollabError(event, error);
    }
  }

  return {
    connect,
    connectTo,
    disconnect,
    onCollabEvent,
    onReceiveMessage,
    storeState,
    data: computed(() => storeState.data),
    readonly: computed(() => storeState.connection?.connectionState !== CollabConnectionState.OPEN || !storeState.permissions.write),
    connection: computed(() => storeState.connection),
    collabProps: computedThrottled(() => ({
      path: storeState.apiPath,
      clients: storeState.awareness.clients.map((c) => {
        const a = c.client_id === storeState.clientID ? 
          storeState.awareness.self : 
          storeState.awareness.other[c.client_id];
        return {
          ...c,
          path: storeState.apiPath + (a?.path || ''),
          selection: a?.selection,
          isSelf: c.client_id === storeState.clientID,
        };
      }),
      comments: !storeState.data.comments ? undefined : (
        sortBy(Object.values(storeState.data.comments), ['created'])
          .filter(c => c.status === CommentStatus.OPEN)
          .map(c => ({ ...c, collabPath: storeState.apiPath + c.path }))
      ),
      search: storeState.search,
    }), { throttle: 1000 }),
    search: computed({
      get: () => storeState.search,
      set: (v: string) => { storeState.search = v; }, 
    }),
  }
}

export type CollabPropType = {
  path: string;
  clients: {
    client_id: string;
    client_color: string;
    user?: UserShortInfo|null;
    path: string;
    selection?: EditorSelection;
    isSelf: boolean;
  }[];
  comments?: Comment[];
  search?: string;
};

export function collabSubpath(collab: CollabPropType, subPath: string|null) {
  const addDot = !collab.path.endsWith('.') && !collab.path.endsWith('/') && subPath;
  const path = collab.path + (addDot ? '.' : '') + (subPath || '');

  return {
    ...collab,
    path,
    clients: collab.clients.filter(a => isSubpath(a.path, path)),
    comments: collab.comments?.filter(c => isSubpath(c.collabPath || '', path)),
  };
}
