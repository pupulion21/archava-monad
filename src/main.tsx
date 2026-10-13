import React from "react";
import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import App from "./App";
import { PrivyWalletBridge } from "./components/PrivyWalletBridge";
import { MONAD_PRIVY_CHAIN } from "./lib/wallet";
import "./styles.css";

const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID || "").trim();

function Root() {
  if (PRIVY_APP_ID) {
    return (
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          defaultChain: MONAD_PRIVY_CHAIN,
          supportedChains: [MONAD_PRIVY_CHAIN],
          embeddedWallets: {
            showWalletUIs: true,
            ethereum: {
              createOnLogin: "users-without-wallets",
            },
          },
          // Use the login methods enabled for this app in the Privy Dashboard.
          appearance: {
            theme: "dark",
            accentColor: "#836EF9",
          },
        }}
      >
        <PrivyWalletBridge>
          <App />
        </PrivyWalletBridge>
      </PrivyProvider>
    );
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

