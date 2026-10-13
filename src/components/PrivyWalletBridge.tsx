import React, { useEffect, useState, useCallback, useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  MONAD_CHAIN_ID,
  setSelectedWallet,
  getSelectedWallet,
  connectExternalWallet,
  type EthereumProvider,
} from "../lib/wallet";
import { operationController } from "../lib/operationLock";
import { PrivyContext, type PrivyControllerState } from "../lib/privy";

interface PrivyWalletBridgeProps {
  children: React.ReactNode;
  onWalletChange?: (wallet: string) => void;
}

export function PrivyWalletBridge({ children, onWalletChange }: PrivyWalletBridgeProps) {
  const { ready: privyReady, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [syncedAddress, setSyncedAddress] = useState<string>("");

  const userEmail = useMemo(() => {
    return user?.email?.address || (user?.google as any)?.email || undefined;
  }, [user]);

  // Handle Privy authentication & wallet synchronization
  useEffect(() => {
    if (!privyReady || !walletsReady) return;

    if (!authenticated) {
      const current = getSelectedWallet();
      if (current?.type === "privy") {
        setSelectedWallet(null);
        operationController.invalidate("privyLogout");
        setSyncedAddress("");
        onWalletChange?.("");
      }
      return;
    }

    // Identify the primary wallet for the authenticated user
    const primaryWallet =
      wallets.find((w) => w.address.toLowerCase() === user?.wallet?.address?.toLowerCase()) ||
      wallets[0];

    if (!primaryWallet) {
      // User is authenticated but embedded wallet is still initializing
      return;
    }

    let active = true;

    void (async () => {
      try {
        const ethProvider = (await primaryWallet.getEthereumProvider()) as EthereumProvider;
        if (!active) return;

        // Ensure Monad Testnet is selected
        if (typeof primaryWallet.switchChain === "function") {
          try {
            await primaryWallet.switchChain(MONAD_CHAIN_ID);
          } catch {
            // Handled during actual transactions
          }
        }

        if (!active) return;

        setSelectedWallet({
          provider: ethProvider,
          address: primaryWallet.address,
          type: "privy",
          chainId: MONAD_CHAIN_ID,
        });

        setSyncedAddress(primaryWallet.address);
        onWalletChange?.(primaryWallet.address);
      } catch (err) {
        if (!active) return;
        console.warn("[Privy] Error acquiring provider from wallet:", err);
      }
    })();

    return () => {
      active = false;
    };
  }, [privyReady, walletsReady, authenticated, user?.wallet?.address, wallets, onWalletChange]);

  const handleLogout = useCallback(async () => {
    setSelectedWallet(null);
    operationController.invalidate("logout");
    setSyncedAddress("");
    onWalletChange?.("");
    await logout();
  }, [logout, onWalletChange]);

  const handleConnectExternal = useCallback(async () => {
    const { address } = await connectExternalWallet();
    setSyncedAddress(address);
    onWalletChange?.(address);
    return address;
  }, [onWalletChange]);

  const controllerValue: PrivyControllerState = useMemo(() => {
    return {
      isConfigured: true,
      isReady: privyReady && walletsReady,
      authenticated,
      userEmail,
      walletAddress: syncedAddress,
      walletType: authenticated ? "privy" : getSelectedWallet()?.type || "none",
      login,
      logout: handleLogout,
      connectExternal: handleConnectExternal,
    };
  }, [privyReady, walletsReady, authenticated, userEmail, syncedAddress, login, handleLogout, handleConnectExternal]);

  return (
    <PrivyContext.Provider value={controllerValue}>
      {children}
    </PrivyContext.Provider>
  );
}
