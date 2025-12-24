import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

///////////////////////////////////////////////////////////////////////////////
// Hardcode your credentials here (as requested).
///////////////////////////////////////////////////////////////////////////////

const OPENAI_API_KEY = '';
const SIP_URI = ''; // example: "sip:1234@test.example.com"
const SIP_USER = ''; // example: "1234"
const SIP_PASS = ''; // example: "12345"

// Optional override. If empty, defaults to: wss://<domain-from-SIP_URI>/ws
const SIP_WS = '';

///////////////////////////////////////////////////////////////////////////////
// Phonebook (freeform file)
///////////////////////////////////////////////////////////////////////////////

const PHONEBOOK_PATH = fileURLToPath(new URL('../phonebook.txt', import.meta.url));

///////////////////////////////////////////////////////////////////////////////

function requireNonEmpty(name, value) {
  if (!value || !String(value).trim()) throw new Error(`Missing ${name} (edit scripts/bridge.js and hardcode it).`);
}

function loadPhonebook(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const entries = [];
  const seen = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('-')) line = line.replace(/^-+\s*/, '');

    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash).trim();
    if (!line) continue;

    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;

    const name = parts[0];
    const number = parts[1];
    const description = parts.slice(2).join(', ').trim();

    if (!name || !number) continue;

    const key = `${name.toLowerCase()}|${number}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({ name, number, description });
  }

  return entries;
}

function parseSipUri(uri) {
  const m = /^sip:([^@]+)@([^;>]+)(?:;.*)?$/i.exec(String(uri).trim());
  if (!m) throw new Error(`Invalid SIP_URI: ${uri}`);
  return { user: m[1], domain: m[2] };
}

function defaultWsFromSipUri(uri) {
  const { domain } = parseSipUri(uri);
  const host = domain.split(':')[0];
  return `wss://${host}/ws`;
}

function isProbablyNumber(str) {
  return /^[0-9+*#().\s-]+$/.test(String(str ?? '').trim());
}

function isSipUri(str) {
  const s = String(str ?? '').trim();
  return s.startsWith('sip:') || s.includes('@');
}

function resolveRecipient(toArg, phonebook) {
  const q = String(toArg ?? '').trim();
  if (!q) return null;

  if (isSipUri(q)) return { name: q, number: q, description: '' };

  const byNumber = phonebook.find((e) => e.number === q);
  if (byNumber) return byNumber;

  const byName = phonebook.find((e) => e.name.toLowerCase() === q.toLowerCase());
  if (byName) return byName;

  if (isProbablyNumber(q)) return { name: q, number: q, description: '' };
  return null;
}

function buildTargetUri({ to }) {
  if (isSipUri(to)) return to;
  const { domain } = parseSipUri(SIP_URI);
  return `sip:${to}@${domain}`;
}

function usage() {
  const lines = [];
  lines.push('Usage: node scripts/bridge.js --to <name|number|sip:...> [--prompt "<text>"] [--list]');
  lines.push('');
  lines.push('Examples:');
  lines.push('  node scripts/bridge.js --list');
  lines.push('  node scripts/bridge.js --to Alice --prompt "Say hello and ask about the report."');
  lines.push('  node scripts/bridge.js --to 1234 --prompt "Hello!"');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { to: null, prompt: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--prompt') args.prompt = argv[++i];
    else if (!a.startsWith('-') && !args.to) args.to = a;
    else if (!a.startsWith('-') && args.to && !args.prompt) args.prompt = a;
  }
  return args;
}

function listPhonebook() {
  const phonebook = loadPhonebook(PHONEBOOK_PATH);
  for (const e of phonebook) {
    const desc = e.description ? ` — ${e.description}` : '';
    // eslint-disable-next-line no-console
    console.log(`- ${e.name}, ${e.number}${desc}`);
  }
}

function buildCallPrompt({ recipient, userPrompt }) {
  const desc = recipient.description ? `\nAbout ${recipient.name}: ${recipient.description}` : '';
  const task = userPrompt?.trim()
    ? `\n\nYour task for this call:\n${userPrompt.trim()}`
    : '\n\nYour task for this call:\nStart with a short greeting and wait for their reply.';

  return (
    `You are a helpful voice assistant calling ${recipient.name} (${recipient.number}).` +
    `${desc}` +
    `\n\nCall style:\n- Speak in short sentences.\n- Start with "Hello!" and wait for them to respond.\n- Be polite and clear.\n` +
    `${task}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    try {
      listPhonebook();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to read phonebook at ${PHONEBOOK_PATH}`);
      // eslint-disable-next-line no-console
      console.error(err?.message ?? err);
      process.exitCode = 1;
    }
    return;
  }

  if (!args.to) {
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  requireNonEmpty('OPENAI_API_KEY', OPENAI_API_KEY);
  requireNonEmpty('SIP_URI', SIP_URI);
  requireNonEmpty('SIP_USER', SIP_USER);
  requireNonEmpty('SIP_PASS', SIP_PASS);

  process.env.OPENAI_API_KEY = OPENAI_API_KEY;

  const sipWs = SIP_WS?.trim() ? SIP_WS.trim() : defaultWsFromSipUri(SIP_URI);
  const phonebook = loadPhonebook(PHONEBOOK_PATH);
  const recipient = resolveRecipient(args.to, phonebook);
  if (!recipient) {
    // eslint-disable-next-line no-console
    console.error(`Unknown recipient "${args.to}". Add them to ${PHONEBOOK_PATH} or pass a number/SIP URI.`);
    process.exitCode = 2;
    return;
  }
  const targetUri = buildTargetUri({ to: recipient.number });

  let SIPClient;
  let OpenAIRealtimeAudio;
  let pipeAudio;
  try {
    ({ SIPClient } = await import('./sip.js'));
    ({ default: OpenAIRealtimeAudio } = await import('./openaiRealtimeAudio.js'));
    ({ pipeAudio } = await import('./audioPipe.js'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Missing Node dependencies. Run: cd scripts && npm install');
    throw err;
  }

  const sipClient = new SIPClient({
    ws: sipWs,
    uri: SIP_URI,
    user: SIP_USER,
    pass: SIP_PASS,
    displayName: 'OpenAI-Bridge'
  });

  sipClient.start();
  await Promise.race([
    once(sipClient, 'registered'),
    once(sipClient, 'registrationFailed').then(([e]) => {
      throw new Error(`SIP registration failed: ${e?.cause ?? 'unknown cause'}`);
    })
  ]);

  // eslint-disable-next-line no-console
  console.log(`Calling ${recipient.name} at ${targetUri} ...`);

  const sipSession = sipClient.call(targetUri);

  const openai = new OpenAIRealtimeAudio({
    model: 'gpt-4o-mini-realtime-preview',
    voice: 'alloy',
    prompt: buildCallPrompt({ recipient, userPrompt: args.prompt }),
    tools: [
      {
        type: 'function',
        name: 'end_call',
        description: 'End the current phone call.',
        parameters: {}
      }
    ],
    toolHandlers: {
      end_call: () => {
        // eslint-disable-next-line no-console
        console.log('OpenAI requested end_call; terminating SIP session.');
        sipSession.terminate();
      }
    }
  });

  openai.start();

  const unsubscribe = [];
  unsubscribe.push(pipeAudio(sipSession, openai));
  unsubscribe.push(pipeAudio(openai, sipSession));

  const done = Promise.race([once(sipSession, 'sessionEnded'), once(sipSession, 'sessionFailed')]);

  const cleanup = () => {
    for (const u of unsubscribe) {
      try {
        u?.();
      } catch {}
    }
    openai.close();
    sipClient.stop();
  };

  process.once('SIGINT', () => {
    // eslint-disable-next-line no-console
    console.log('\nSIGINT: terminating...');
    try {
      sipSession.terminate();
    } catch {}
    cleanup();
  });

  await done;
  cleanup();

  const transcripts = openai.getTranscripts();
  if (transcripts.length) {
    // eslint-disable-next-line no-console
    console.log('\nTranscripts:');
    for (const t of transcripts) {
      // eslint-disable-next-line no-console
      console.log(`[${t.role}] ${t.content}`);
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
