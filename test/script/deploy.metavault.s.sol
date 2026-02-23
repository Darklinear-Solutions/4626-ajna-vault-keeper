pragma solidity ^0.8.26;

// TODO: Split this script into two: one for ARKs, one for external contracts, to resolve pragma error

import {Script} from 'forge-std/Script.sol';
import {EulerEarnFactory} from 'euler-earn/src/EulerEarnFactory.sol';
import {EulerEarn} from 'euler-earn/src/EulerEarn.sol';
import {Vault} from '../../lib/4626-ajna-vault/src/Vault.sol';
import {VaultAuth} from '../../lib/4626-ajna-vault/src/VaultAuth.sol';
import {ATokenVaultFactory} from 'Aave-Vault/src/ATokenVaultFactory.sol';
import {ATokenRevenueSplitterOwner} from 'Aave-Vault/src/ATokenRevenueSplitterOwner.sol';
import {IPoolAddressesProvider} from 'Aave-Vault/lib/aave-v3-core/interfaces/IPoolAddressesProvider.sol';
import {MockPerspective} from '../mocks/contracts/MockPerspective.sol';
import {IPool} from "ajna-core/interfaces/pool/IPool.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);
        address sUSDeDaiPoolAddress = 0x34bC3D3d274A355f3404c5dEe2a96335540234de;
        address evcAddress = 0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383;
        address permit2Address = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        address poolAddressProvider = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
        IPool pool = IPool(sUSDeDaiPoolAddress);
        ATokenVaultFactory aaveFactory;
        address aTokenVaultAddress;
        EulerEarnFactory metavaultFactory;
        EulerEarn metavault;
        Vault ark1;
        Vault ark2;
        Vault ark3;
        VaultAuth arkAuth1;
        VaultAuth arkAuth2;
        VaultAuth arkAuth3;

        vm.startBroadcast(deployerPrivateKey)
        arkAuth1 = new VaultAuth();
        ark1 = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            "test",
            "TEST",
            vaultAuth
        );

        arkAuth2 = new VaultAuth();
        ark2 = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            "test",
            "TEST",
            vaultAuth
        );

        arkAuth3 = new VaultAuth();
        ark3 = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            "test",
            "TEST",
            vaultAuth
        );

        arkAuth1.setKeeper(deployerAddress, true);
        arkAuth2.setKeeper(deployerAddress, true);
        arkAuth3.setKeeper(deployerAddress, true);

        metavaultFactory = new EulerEarnFactory(
            deployerAddress,
            evcAddress,
            permit2Address,
            new MockPerspective()
        );

        metavault = metavaultFactory.createEulerEarn(
            deployerAddress,
            0,
            pool.quoteTokenAddress(),
            "test",
            "TEST",
            bytes32(0)
        );

        aaveFactory = new ATokenVaultFactory(deployerAddress);
        IERC20(pool.quoteTokenAddress()).approve(address(aaveFactory), type(uint256).max);

        ATokenRevenueSplitterOwner.Recipient[] memory revenueRecipients = new ATokenRevenueSplitterOwner.Recipient[](1);
        revenueRecipients[0] = ATokenRevenueSplitterOwner.Recipient({
            addr: deployerAddress,
            shareInBps: 100_00
        });

        ATokenVaultFactory.VaultParams memory aaveParams = ATokenVaultFactory.VaultParams({
            underlying: pool.quoteTokenAddress(),
            referralCode: 42,
            poolAddressesProvider: IPoolAddressesProvider(poolAddressProvider),
            owner: deployerAddress,
            initialFee: 0,
            shareName: "test",
            shareSymbol: "TEST",
            initialLockDeposit: 1,
            revenueRecipients: revenueRecipients
        });

        aTokenVaultAddress = aaveFactory.deployVault(aaveParams);

        vm.stopBroadcast();

        string memory addresses = string.concat(
          "ARK_1_ADDRESS=", vm.toString(address(ark1)), "\n"
          "ARK_2_ADDRESS=", vm.toString(address(ark2)), "\n"
          "ARK_3_ADDRESS=", vm.toString(address(ark3)), "\n"
          "ARK_AUTH_1_ADDRESS=", vm.toString(address(arkAuth1)), "\n"
          "ARK_AUTH_2_ADDRESS=", vm.toString(address(arkAuth2)), "\n"
          "ARK_AUTH_3_ADDRESS=", vm.toString(address(arkAuth3)), "\n"
          "METAVAULT_ADDRESS=", vm.toString(address(metavault)), "\n"
          "AAVE_VAULT_ADDRESS=", vm.toString(aTokenVaultAddress), "\n"
        );

        vm.writeFile("test/script/test-addresses.env", addresses);
    }
}
