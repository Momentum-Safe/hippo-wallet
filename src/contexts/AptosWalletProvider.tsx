import { createContext, FC, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AptosAccountState,
  AptosImportedWalletObject,
  AptosWalletAccount,
  WalletNameObject
} from 'types/aptos';
import { WALLET_STATE_NETWORK_LOCAL_STORAGE_KEY } from 'config/aptosConstants';
import {
  AptosNetwork,
  createNewAccount,
  getAptosWalletList,
  getLocalStorageNetworkState,
  getPrivateKeyImports,
  setWalletNameList,
  storePrivateKeyImports
} from 'utils/aptosUtils';
import { logoutAccount, useUnlockedMnemonicAndSeed } from 'utils/wallet-seed';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { AptosAccount } from 'aptos';
import { faucetClient } from 'config/aptosClient';

interface AptosWalletContextType {
  activeWallet?: AptosWalletAccount;
  aptosNetwork: AptosNetwork | null;
  disconnect: () => void;
  aptosWalletAccounts: AptosWalletAccount[];
  updateNetworkState: (network: AptosNetwork) => void;
  setWalletList: React.Dispatch<React.SetStateAction<WalletNameObject>>;
  walletList: Record<string, AptosImportedWalletObject>;
  addAccount: (walletName: string, importedAccount?: AptosAccount) => void;
  updateAccountInfo: (address: string, walletName: string) => void;
  setActiveAptosWallet: (address?: string) => void;
}

interface TProviderProps {
  children: ReactNode;
}

const AptosWalletContext = createContext<AptosWalletContextType>({} as AptosWalletContextType);

const AptosWalletProvider: FC<TProviderProps> = ({ children }) => {
  const [privateKeyImports, setPrivateKeyImports] =
    useState<Record<string, AptosImportedWalletObject>>(getPrivateKeyImports);
  const [walletList, setWalletList] = useState<WalletNameObject>(getAptosWalletList);
  const [activeWallet, setActiveWallet] = useState<AptosWalletAccount | undefined>(undefined);
  const [aptosNetwork, setAptosNetwork] = useState<AptosNetwork | null>(() =>
    getLocalStorageNetworkState()
  );
  const {
    mnemonic: { seed, derivationPath, importsEncryptionKey }
  } = useUnlockedMnemonicAndSeed();

  const { aptosWalletAccounts }: { aptosWalletAccounts: AptosWalletAccount[] } = useMemo(() => {
    if (!seed || !derivationPath) {
      return { aptosWalletAccounts: [{} as AptosWalletAccount] };
    }

    const importedAccounts = Object.keys(privateKeyImports).map((address, idx) => {
      const { ciphertext, nonce } = privateKeyImports[address];
      let aptosAccount = {} as AptosAccount;
      if (importsEncryptionKey) {
        const privateKey = nacl.secretbox.open(
          bs58.decode(ciphertext),
          bs58.decode(nonce),
          importsEncryptionKey
        );
        if (privateKey) {
          aptosAccount = new AptosAccount(privateKey);
        }
      }
      const wallet = walletList[idx];
      return {
        address: address,
        walletName: wallet.walletName,
        aptosAccount
      };
    });
    return { aptosWalletAccounts: [...importedAccounts] };
  }, [seed, derivationPath, privateKeyImports, importsEncryptionKey, walletList]);

  // Set the current selected Aptos wallet
  const setActiveAptosWallet = useCallback(
    async (address?: string) => {
      if (!aptosWalletAccounts || !aptosWalletAccounts.length)
        throw new Error('Please login first');
      let selectedWallet: AptosWalletAccount | undefined = aptosWalletAccounts[0];
      if (address) {
        selectedWallet = aptosWalletAccounts.find((wallet) => wallet.address === address);
      }
      if (!selectedWallet) throw new Error('Wallet not found');
      setActiveWallet(selectedWallet);
    },
    [setActiveWallet, aptosWalletAccounts]
  );

  // Add new account or import account from private key
  const addAccount = useCallback(
    async (walletName?: string, importedAccount?: AptosAccountState) => {
      if (importedAccount) {
        if (importsEncryptionKey) {
          const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
          const plaintext = importedAccount.signingKey.secretKey;
          const ciphertext = nacl.secretbox(plaintext, nonce, importsEncryptionKey);
          const privateObjKey = importedAccount.toPrivateKeyObject();
          let newPrivateKeyImports = { ...privateKeyImports };
          newPrivateKeyImports[privateObjKey.address || ''] = {
            ciphertext: bs58.encode(ciphertext),
            nonce: bs58.encode(nonce)
          };
          const numOfWalletList = Object.keys(walletList).length;
          if (walletName) {
            const updatedWalletList = { ...walletList, [numOfWalletList]: { walletName } };
            setWalletList(updatedWalletList);
            setWalletNameList(updatedWalletList);
          }
          storePrivateKeyImports(newPrivateKeyImports);
          setPrivateKeyImports(newPrivateKeyImports);
        }
      }
    },
    [importsEncryptionKey, privateKeyImports, walletList]
  );

  const loginAccount = useCallback(async () => {
    if (seed && derivationPath) {
      if (!privateKeyImports || !Object.keys(privateKeyImports).length) {
        // create new account when there is no other accounts imported
        const account = createNewAccount();
        await faucetClient.fundAccount(account.address(), 0);
        const newWalletAccount = walletList[0];
        const privateKeyObj = account?.toPrivateKeyObject();
        await addAccount(undefined, account);
        const selectedWallet = {
          ...newWalletAccount,
          address: privateKeyObj?.address,
          aptosAccount: account
        };
        setActiveWallet(selectedWallet);
        setWalletNameList(walletList);
      } else {
        // login existing account
        setActiveAptosWallet(activeWallet?.address);
      }
    }
  }, [
    seed,
    derivationPath,
    setActiveAptosWallet,
    privateKeyImports,
    addAccount,
    walletList,
    activeWallet?.address
  ]);

  useEffect(() => {
    // This is used to listen on any updates of Mnemonic/Seed when new account is created/login
    loginAccount();
  }, [aptosWalletAccounts, loginAccount, seed, derivationPath]);

  // Update wallet name
  const updateAccountInfo = useCallback(
    (address: string, walletName: string) => {
      const walletIdx = aptosWalletAccounts.findIndex((acc) => acc.address === address);
      const updatedWallets = { ...walletList, [walletIdx]: { walletName } };
      setWalletList(updatedWallets);
      setWalletNameList(updatedWallets);
    },
    [aptosWalletAccounts, walletList]
  );

  // useEffect(() => {
  //   if (window.parent && activeWallet?.aptosAccount) {
  //     window.parent.postMessage({ address: activeWallet?.aptosAccount.address() }, '*');
  //   }
  // }, [activeWallet]);

  const updateNetworkState = useCallback((network: AptosNetwork) => {
    try {
      setAptosNetwork(network);
      window.localStorage.setItem(WALLET_STATE_NETWORK_LOCAL_STORAGE_KEY, network);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(error);
    }
  }, []);

  const disconnect = useCallback(() => {
    logoutAccount();
    setActiveWallet(undefined);
  }, []);

  return (
    <AptosWalletContext.Provider
      value={{
        activeWallet,
        setActiveAptosWallet,
        addAccount,
        aptosNetwork,
        disconnect,
        updateNetworkState,
        walletList: privateKeyImports,
        updateAccountInfo,
        setWalletList,
        aptosWalletAccounts
      }}>
      {children}
    </AptosWalletContext.Provider>
  );
};

export { AptosWalletProvider, AptosWalletContext };
