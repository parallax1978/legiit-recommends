/**
 * Runs the deterministic provider double as a standalone server for local development and the
 * end-to-end tests. It never contacts OpenAI and its answers are synthetic.
 *
 *   npm run fake-openai -- --port 4010 [--organic "best plumbers::Example Plumbing Co"]
 *
 * Point the Edge Functions at it with OPENAI_BASE_URL=http://host.docker.internal:4010/v1 in
 * supabase/functions/.env, and use an API key starting with "sk-fake-valid".
 */
import { FakeOpenAI, FAKE_MODELS, VALID_KEY_PREFIX } from "./fake-openai";

function argument(name: string): string[] {
  const values: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1]) values.push(argv[i + 1]!);
    else if (argv[i]?.startsWith(`--${name}=`)) values.push(argv[i]!.slice(name.length + 3));
  }
  return values;
}

async function main() {
  const port = Number(argument("port")[0] ?? process.env.FAKE_OPENAI_PORT ?? 4010);
  const host = argument("host")[0] ?? "0.0.0.0";
  const fake = new FakeOpenAI();
  for (const rule of argument("organic")) {
    const [question, business] = rule.split("::");
    if (question && business) fake.includeOrganically(question, business);
  }
  await fake.start(port, host);
  console.log(
    `Fake OpenAI (synthetic answers, no real API calls) listening on http://${host}:${fake.port}/v1`,
  );
  console.log(
    `Models: ${FAKE_MODELS.map((model) => model.id).join(", ")} · accepted keys start with "${VALID_KEY_PREFIX}"`,
  );

  const stop = () => {
    void fake.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
