/**
 * What the app remembers about the signed-in account (portfolio, AI agent,
 * guardian) is dropped the moment the account changes. Without this, signing
 * out and in as someone else in the same tab kept showing the previous
 * account's portfolio until the page was reloaded.
 */
import { useAuthStore } from '@/stores/auth';
import { usePortfolioStore } from '@/stores/portfolio';
import { useAIAgentStore } from '@/stores/ai-agent';
import { useGuardianStore } from '@/stores/guardian';

export function forgetAccountState(): void {
  usePortfolioStore.setState(usePortfolioStore.getInitialState(), true);
  useAIAgentStore.setState(useAIAgentStore.getInitialState(), true);
  useGuardianStore.setState(useGuardianStore.getInitialState(), true);
}

let installed = false;
export function installAccountStateReset(): void {
  if (installed) return;
  installed = true;
  let token = useAuthStore.getState().token ?? null;
  useAuthStore.subscribe((s) => {
    const next = s.token ?? null;
    if (next === token) return;
    token = next;
    forgetAccountState();
  });
}
