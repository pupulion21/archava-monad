// Resolved only by the isolated UI test server. Never contacts Privy or signs a transaction.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const Context = createContext<any>(null);
const ADDRESS = "0x3333333333333333333333333333333333333333";

export function PrivyProvider({ children }: { children: ReactNode }) {
  const options = (window as any).__ARCHAVA_UI_PRIVY;
  const [authenticated, setAuthenticated] = useState(Boolean(options.authenticated));
  const [ready, setReady] = useState(options.ready !== false);
  const [modalOpen, setModalOpen] = useState(false);
  const login = useCallback(() => {
    options.loginCalls++;
    setModalOpen(true);
  }, [options]);
  const logout = useCallback(async () => {
    options.logoutCalls++;
    if (options.logoutFailure) throw new Error("Simulated Privy logout failure");
    setAuthenticated(false);
    setModalOpen(false);
  }, [options]);
  const wallets = useMemo(() => [{
    address: ADDRESS,
    async getEthereumProvider() {
      options.providerRequests++;
      if (options.providerDelay) await new Promise(resolve => setTimeout(resolve, options.providerDelay));
      return {
        async request({ method }: { method: string }) {
          options.providerMethods.push(method);
          if (method === "eth_chainId") return "0x279f";
          if (method === "eth_accounts") return [ADDRESS];
          throw new Error("Privy UI fixture does not sign or transact");
        },
        on() {}, removeListener() {},
      };
    },
    async switchChain() {},
  }], [options]);
  (window as any).__ARCHAVA_UI_SET_PRIVY_READY = setReady;
  return (
    <Context.Provider value={{ ready, authenticated, user: authenticated ? { wallet: { address: ADDRESS } } : null, login, logout, wallets: authenticated ? wallets : [] }}>
      {children}
      {modalOpen && (
        <div role="dialog" aria-modal="true" aria-label="Fixture login" style={{ position: "fixed", inset: 0, zIndex: 1200, display: "grid", placeContent: "center", background: "#0e091c" }}>
          <button type="button" onClick={() => { setAuthenticated(true); setModalOpen(false); }}>Continue with fixture account</button>
          <button type="button" onClick={() => setModalOpen(false)}>Cancel login</button>
        </div>
      )}
    </Context.Provider>
  );
}

export function usePrivy() { return useContext(Context); }
export function useWallets() {
  const { ready, wallets } = useContext(Context);
  return { ready, wallets };
}
