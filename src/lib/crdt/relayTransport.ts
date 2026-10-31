import mqtt from 'mqtt';
import { PubSubBus, PubSubBusFactory, PubSubTransport } from './docSync';

/**
 * Fallback transport for peers that cannot open a direct WebRTC connection
 * (Wi-Fi client isolation, mDNS blocked, symmetric/carrier-grade NAT) and no
 * TURN server is available. Messages travel through public MQTT brokers, but
 * are end-to-end encrypted: the brokers only see a hashed topic and AES-GCM
 * ciphertext whose key is derived from the room ID, which they never receive.
 */
export const RELAY_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveRelayChannel(roomId: string): Promise<{ topic: string; key: CryptoKey }> {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(roomId), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('editordoc-relay-v1'), info: enc.encode('aes-gcm-256') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { topic: `editordoc/v1/${await sha256Hex('editordoc-relay-topic-v1:' + roomId)}`, key };
}

/** iv (12 bytes) || AES-GCM(JSON) */
export async function sealMessage(key: CryptoKey, msg: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(msg))));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function openMessage(key: CryptoKey, data: Uint8Array): Promise<any> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12));
  return JSON.parse(dec.decode(pt));
}

const openMqttBus: PubSubBusFactory = (roomId, onMessage, selfId): PubSubBus => {
  const channel = deriveRelayChannel(roomId);
  const clients = RELAY_BROKERS.map((url) =>
    // queueQoSZero off: an unreachable broker would otherwise buffer every message forever
    mqtt.connect(url, { reconnectPeriod: 5000, connectTimeout: 10000, clean: true, queueQoSZero: false })
  );
  // Every message is published to all brokers for redundancy; deliver each once.
  const seen = new Set<string>();
  let sendChain: Promise<unknown> = Promise.resolve(); // keep publish order

  clients.forEach((client) => {
    // Room topic for broadcasts + a personal inbox, so a PDF streamed to one peer
    // isn't also pushed through every other peer's connection
    client.on('connect', () =>
      channel.then(({ topic }) => client.subscribe([topic, `${topic}/${selfId}`], { qos: 0 }))
    );
    client.on('error', (err) => console.warn('Relay broker error:', err.message));
    client.on('message', async (_topic, payload) => {
      try {
        const { id, msg } = await openMessage((await channel).key, new Uint8Array(payload));
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > 2000) seen.delete(seen.values().next().value as string);
        onMessage(msg);
      } catch {
        /* not ours / tampered: ignore */
      }
    });
  });

  return {
    post(msg, targetId) {
      sendChain = sendChain
        .then(async () => {
          const { topic: room, key } = await channel;
          const topic = targetId ? `${room}/${targetId}` : room;
          const sealed = await sealMessage(key, { id: crypto.randomUUID(), msg });
          // Brokers that are down drop it; the other broker and retries cover that
          clients.forEach((c) => c.publish(topic, sealed as any, { qos: 0 }));
        })
        .catch((err) => console.warn('Relay publish failed:', err));
    },
    close() {
      // Flush queued messages (e.g. 'leave') before closing
      sendChain.finally(() => clients.forEach((c) => c.end(false)));
    },
  };
};

export const createRelayTransport = () => new PubSubTransport('MQTT-Relay', openMqttBus, true);
