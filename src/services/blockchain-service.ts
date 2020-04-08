import { config } from 'node-config-ts';
import { Logger as logger } from '@overnightjs/logger';

import CID from 'cids';
import Context from '../context';
import Contextual from '../contextual';
import { ethers, utils } from 'ethers';
import { BaseProvider, Block, TransactionReceipt, TransactionRequest, TransactionResponse } from 'ethers/providers';
import Transaction from '../models/transaction';

/**
 * Schedules anchor operations
 */
export default class BlockchainService implements Contextual {
  private ctx: Context;
  private provider: BaseProvider;

  setContext(context: Context): void {
    this.ctx = context;
  }

  /**
   * Connects to blockchain
   */
  public async connect(): Promise<void> {
    logger.Imp('Connecting to ' + config.blockchain.network + ' blockchain provider');
    const { network } = config.blockchain;

    if (network === 'ganache') {
      const { host, port } = config.blockchain.rpc;
      const url = `${host}:${port}`;
      this.provider = new ethers.providers.JsonRpcProvider(url);
    } else {
      this.provider = ethers.getDefaultProvider(network);
    }

    await this.provider.getNetwork();
  }

  /**
   * Sends transaction with root CID as data
   */
  public async sendTransaction(rootCid: CID): Promise<Transaction> {
    const wallet = new ethers.Wallet(config.blockchain.account.privateKey, this.provider);

    const hexEncoded = '0x' + rootCid.toBaseEncodedString('base16');

    const txResponse: TransactionResponse = await wallet.sendTransaction({
      to: wallet.address,
      data: hexEncoded,
      gasLimit: config.blockchain.gasLimit,
      gasPrice: utils.bigNumberify(config.blockchain.gasPrice),
    });

    const txReceipt: TransactionReceipt = await this.provider.waitForTransaction(txResponse.hash);
    const block: Block = await this.provider.getBlock(txReceipt.blockHash);
    return new Transaction(txResponse.chainId, txReceipt.transactionHash, txReceipt.blockNumber, block.timestamp);
  }
}