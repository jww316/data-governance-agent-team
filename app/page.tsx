import { getGovernanceView } from "@/lib/governance";
import { Console } from "./components/Console";

// The governance view is loaded on the server from the same YAML the engine
// reads — the UI never hardcodes the contracts, policies, schema, or scenarios.
export default function Home() {
  const view = getGovernanceView();
  return <Console view={view} />;
}
