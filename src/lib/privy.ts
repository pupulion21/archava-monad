import { createContext, useContext } from "react";
import type { WalletProviderType } from "./wallet";

export interface PrivyControllerState {
  isConfigured: boolean;
  isReady: boolean;
  authenticated: boolean;
  userEmail?: string;
  walletAddress?: string;
  walletType: WalletProviderType | "none";
  login: () => void;
  logout: () => Promise<void>;
  connectExternal: () => Promise<string>;
}

export const defaultPrivyState: PrivyControllerState = {
  isConfigured: false,
  isReady: true,
  authenticated: false,
  walletType: "none",
  login: () => {},
  logout: async () => {},
  connectExternal: async () => {
    const { connectExternalWallet } = await import("./wallet");
    const { address } = await connectExternalWallet();
    return address;
  },
};

export const PrivyContext = createContext<PrivyControllerState>(defaultPrivyState);

export function usePrivyController(): PrivyControllerState {
  return useContext(PrivyContext);
}
