pragma solidity ^0.8.26;

import {Script} from 'forge-std/Script.sol';
import {EulerEarnFactory} from 'euler-earn/src/EulerEarnFactory.sol';
import {IEulerEarn} from 'euler-earn/src/interfaces/IEulerEarn.sol';
import {ATokenVaultFactory} from 'Aave-Vault/src/ATokenVaultFactory.sol';
import {ATokenVaultRevenueSplitterOwner} from 'Aave-Vault/src/ATokenVaultRevenueSplitterOwner.sol';
import {IPoolAddressesProvider} from '@aave-v3-core/interfaces/IPoolAddressesProvider.sol';
import {IERC20} from 'openzeppelin-contracts/token/ERC20/IERC20.sol';
import {MockPerspective} from '../mocks/contracts/MockPerspective.sol';
import {ProxyAdmin} from '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol';

interface IAjnaPool {
    function quoteTokenAddress() external view returns (address);
}

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint('PRIVATE_KEY');
        address deployerAddress = vm.addr(deployerPrivateKey);
        address evcAddress = 0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383;
        address permit2Address = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        address poolAddressProvider = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
        address sUSDeDaiPoolAddress = 0x34bC3D3d274A355f3404c5dEe2a96335540234de;
        IAjnaPool pool = IAjnaPool(sUSDeDaiPoolAddress);
        ATokenVaultFactory aaveFactory;
        ProxyAdmin proxyAdmin;
        address aTokenVaultAddress;
        EulerEarnFactory metavaultFactory;
        IEulerEarn metavault;

        vm.startBroadcast(deployerPrivateKey);

        metavaultFactory = new EulerEarnFactory(
            deployerAddress,
            evcAddress,
            permit2Address,
            address(new MockPerspective())
        );

        metavault = metavaultFactory.createEulerEarn(
            deployerAddress,
            0,
            pool.quoteTokenAddress(),
            'test',
            'TEST',
            bytes32(0)
        );

        proxyAdmin = new ProxyAdmin();
        proxyAdmin.renounceOwnership();
        aaveFactory = new ATokenVaultFactory(address(proxyAdmin));
        IERC20(pool.quoteTokenAddress()).approve(address(aaveFactory), type(uint256).max);

        ATokenVaultRevenueSplitterOwner.Recipient[]
            memory revenueRecipients = new ATokenVaultRevenueSplitterOwner.Recipient[](1);
        revenueRecipients[0] = ATokenVaultRevenueSplitterOwner.Recipient({
            addr: deployerAddress,
            shareInBps: 100_00
        });

        ATokenVaultFactory.VaultParams memory aaveParams = ATokenVaultFactory.VaultParams({
            underlying: pool.quoteTokenAddress(),
            referralCode: 42,
            poolAddressesProvider: IPoolAddressesProvider(poolAddressProvider),
            owner: deployerAddress,
            initialFee: 0,
            shareName: 'test',
            shareSymbol: 'TEST',
            initialLockDeposit: 1e18,
            revenueRecipients: revenueRecipients
        });

        aTokenVaultAddress = aaveFactory.deployVault(aaveParams);

        vm.stopBroadcast();

        string memory existingContent = vm.readFile('test/script/test-addresses.env');
        string memory addresses = string.concat(
            existingContent,
            'METAVAULT_ADDRESS=',
            vm.toString(address(metavault)),
            '\n'
            'AAVE_VAULT_ADDRESS=',
            vm.toString(aTokenVaultAddress),
            '\n'
        );

        vm.writeFile('test/script/test-addresses.env', addresses);
    }
}
