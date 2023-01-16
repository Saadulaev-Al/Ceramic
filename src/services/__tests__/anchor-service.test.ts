import 'reflect-metadata'
import { jest } from '@jest/globals'

import { Request, RequestStatus } from '../../models/request.js'
import { AnchorService } from '../anchor-service.js'

import { clearTables, createDbConnection } from '../../db-connection.js'

import { RequestRepository } from '../../repositories/request-repository.js'
import { IpfsService } from '../ipfs-service.js'
import type { IIpfsService } from '../ipfs-service.type.js'
import { AnchorRepository } from '../../repositories/anchor-repository.js'
import { config, Config } from 'node-config-ts'
import { CommitID, StreamID } from '@ceramicnetwork/streamid'
import {
  generateRequests,
  MockCeramicService,
  MockEventProducerService,
  MockIpfsClient,
  randomStreamID,
} from '../../__tests__/test-utils.js'
import type { Knex } from 'knex'
import { CID } from 'multiformats/cid'
import { Candidate } from '../../merkle/merkle-objects.js'
import { Anchor } from '../../models/anchor.js'
import { AnchorStatus, CommitType, LogEntry, toCID } from '@ceramicnetwork/common'
import cloneDeep from 'lodash.clonedeep'
import { Utils } from '../../utils.js'
import { PubsubMessage } from '@ceramicnetwork/core'
import { validate as validateUUID } from 'uuid'
import { TransactionRepository } from '../../repositories/transaction-repository.js'
import type { BlockchainService } from '../blockchain/blockchain-service'
import type { Transaction } from '../../models/transaction.js'
import { createInjector, Injector } from 'typed-inject'

process.env.NODE_ENV = 'test'

class FakeEthereumBlockchainService implements BlockchainService {
  chainId = 'impossible'

  connect(): Promise<void> {
    throw new Error(`Failed to connect`)
  }

  sendTransaction(): Promise<Transaction> {
    throw new Error('Failed to send transaction!')
  }
}

async function createRequest(
  streamId: string,
  ipfsService: IIpfsService,
  requestRepository: RequestRepository,
  status: RequestStatus = RequestStatus.PENDING
): Promise<Request> {
  const cid = await ipfsService.storeRecord({})
  const request = new Request()
  request.cid = cid.toString()
  request.streamId = streamId
  request.status = status
  request.message = 'Request is pending.'
  request.pinned = true

  return requestRepository.createOrUpdate(request)
}

async function anchorCandidates(
  candidates: Candidate[],
  anchorService,
  ipfsService
): Promise<Anchor[]> {
  const merkleTree = await anchorService._buildMerkleTree(candidates)
  const ipfsProofCid = await ipfsService.storeRecord({})

  const anchors = await anchorService._createAnchorCommits(ipfsProofCid, merkleTree)

  await anchorService._persistAnchorResult(anchors, candidates)
  return anchors
}
function createStream(
  id: StreamID,
  log: CID[] | LogEntry[],
  anchorStatus: AnchorStatus = AnchorStatus.PENDING
) {
  return {
    id,
    metadata: { controllers: ['this is totally a did'] },
    state: {
      log: log.map((logEntry) => {
        const cid = CID.asCID(logEntry)
        if (cid) return { cid }
        return logEntry
      }),
      anchorStatus,
      metadata: { controllers: ['this is totally a did'] },
    },
    tip: log[log.length - 1],
  }
}

const mockIpfsClient = new MockIpfsClient()
jest.unstable_mockModule('ipfs-http-client', () => {
  const originalModule = jest.requireActual('ipfs-http-client') as any

  return {
    __esModule: true,
    ...originalModule,
    create: () => {
      return mockIpfsClient
    },
  }
})

const MERKLE_DEPTH_LIMIT = 3
const READY_RETRY_INTERVAL_MS = 1000
const STREAM_LIMIT = Math.pow(2, MERKLE_DEPTH_LIMIT)
const MIN_STREAM_COUNT = Math.floor(STREAM_LIMIT / 2)

type Context = {
  config: Config
  ipfsService: IIpfsService
  ceramicService: MockCeramicService
  eventProducerService: MockEventProducerService
  requestRepository: RequestRepository
  anchorService: AnchorService
}

describe('anchor service', () => {
  jest.setTimeout(10000)
  let ipfsService: IIpfsService
  let ceramicService: MockCeramicService
  let connection: Knex
  let injector: Injector<Context>
  let requestRepository: RequestRepository
  let anchorService: AnchorService
  let eventProducerService: MockEventProducerService

  beforeAll(async () => {
    const { IpfsService } = await import('../ipfs-service.js')

    connection = await createDbConnection()
    injector = createInjector()
      .provideValue('dbConnection', connection)
      .provideValue(
        'config',
        Object.assign({}, config, {
          merkleDepthLimit: MERKLE_DEPTH_LIMIT,
          minStreamCount: MIN_STREAM_COUNT,
          readyRetryIntervalMS: READY_RETRY_INTERVAL_MS,
        })
      )
      .provideClass('anchorRepository', AnchorRepository)
      .provideFactory('requestRepository', RequestRepository.make)
      .provideClass('transactionRepository', TransactionRepository)
      .provideClass('blockchainService', FakeEthereumBlockchainService)
      .provideClass('ipfsService', IpfsService)
      .provideClass('ceramicService', MockCeramicService)
      .provideClass('eventProducerService', MockEventProducerService)
      .provideClass('anchorService', AnchorService)

    ipfsService = injector.resolve('ipfsService')
    await ipfsService.init()
    ceramicService = injector.resolve('ceramicService')
    requestRepository = injector.resolve('requestRepository')
    anchorService = injector.resolve('anchorService')
    eventProducerService = injector.resolve('eventProducerService')
  })

  beforeEach(async () => {
    await clearTables(connection)
    mockIpfsClient.reset()
    ceramicService.reset()
    eventProducerService.reset()
  })

  afterAll(async () => {
    await connection.destroy()
  })

  test('check state on tx fail', async () => {
    const requests: Request[] = []
    for (let i = 0; i < MIN_STREAM_COUNT; i++) {
      const streamId = await randomStreamID()
      const cid = await ipfsService.storeRecord({})
      const streamCommitId = CommitID.make(streamId, cid)
      const stream = createStream(streamId, [cid])
      ceramicService.putStream(streamCommitId, stream)
      ceramicService.putStream(streamId, stream)

      const request = new Request()
      request.cid = cid.toString()
      request.streamId = streamId.toString()
      request.status = RequestStatus.PENDING
      request.message = 'Request is pending.'

      requests.push(request)
    }

    await requestRepository.createRequests(requests)

    await expect(anchorService.anchorRequests()).rejects.toEqual(
      new Error('Failed to send transaction!')
    )

    for (const req of requests) {
      const retrievedRequest = await requestRepository.findByCid(CID.parse(req.cid))
      expect(retrievedRequest).toHaveProperty('status', RequestStatus.PENDING)
    }
  })

  test('Too few anchor requests', async () => {
    const numRequests = MIN_STREAM_COUNT - 1
    // Create pending requests
    for (let i = 0; i < numRequests; i++) {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const stream = createStream(streamId, [toCID(request.cid)])
      ceramicService.putStream(streamId, stream)
      ceramicService.putStream(commitId, stream)
    }

    const beforePending = await requestRepository.countByStatus(RequestStatus.PENDING)
    expect(beforePending).toEqual(numRequests)

    // Should not anchor requests as there aren't at least minStreamCount requests
    await anchorService.anchorRequests()
    const afterPending = await requestRepository.countByStatus(RequestStatus.PENDING)
    expect(afterPending).toEqual(numRequests)
  })

  test('create anchor records', async () => {
    // Create pending requests
    const requests: Request[] = []
    const numRequests = 4
    for (let i = 0; i < numRequests; i++) {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      requests.push(request)
      const commitId = CommitID.make(streamId, request.cid)
      const stream = createStream(streamId, [toCID(request.cid)])
      ceramicService.putStream(streamId, stream)
      ceramicService.putStream(commitId, stream)
    }
    requests.sort(function (a, b) {
      return a.streamId.localeCompare(b.streamId)
    })

    await requestRepository.findAndMarkReady(0)

    const [candidates, _] = await anchorService._findCandidates(requests, 0)
    const merkleTree = await anchorService._buildMerkleTree(candidates)
    const ipfsProofCid = await ipfsService.storeRecord({})

    const anchors = await anchorService._createAnchorCommits(ipfsProofCid, merkleTree)

    expect(candidates.length).toEqual(requests.length)
    expect(anchors.length).toEqual(candidates.length)

    expect(mockIpfsClient.pubsub.publish.mock.calls.length).toEqual(anchors.length)
    const config = injector.resolve('config')

    for (const i in anchors) {
      const anchor = anchors[i]
      expect(anchor.proofCid).toEqual(ipfsProofCid.toString())
      expect(anchor.requestId).toEqual(requests[i].id)

      const anchorRecord = await ipfsService.retrieveRecord(anchor.cid)
      expect(anchorRecord.prev.toString()).toEqual(requests[i].cid)
      expect(anchorRecord.proof).toEqual(ipfsProofCid)
      expect(anchorRecord.path).toEqual(anchor.path)
      expect(mockIpfsClient.pubsub.publish.mock.calls[i][0]).toEqual(config.ipfsConfig.pubsubTopic)
      expect(mockIpfsClient.pubsub.publish.mock.calls[i][1]).toBeInstanceOf(Uint8Array)
    }

    expect(anchors[0].path).toEqual('0/0')
    expect(anchors[1].path).toEqual('0/1')
    expect(anchors[2].path).toEqual('1/0')
    expect(anchors[3].path).toEqual('1/1')
  })

  test('Too many anchor requests', async () => {
    const anchorLimit = 4
    const numRequests = anchorLimit * 2 // twice as many requests as can fit

    // Create pending requests
    for (let i = 0; i < numRequests; i++) {
      const streamId = randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const stream = createStream(streamId, [toCID(request.cid)])
      ceramicService.putStream(streamId, stream)
      ceramicService.putStream(commitId, stream)
    }

    await requestRepository.findAndMarkReady(0)

    // First pass anchors half the pending requests
    let requests = await requestRepository.findByStatus(RequestStatus.READY)
    expect(requests.length).toEqual(numRequests)
    const anchorPendingRequests = async function (requests: Request[]): Promise<void> {
      const [candidates, _] = await anchorService._findCandidates(requests, anchorLimit)
      expect(candidates.length).toEqual(anchorLimit)

      await anchorCandidates(candidates, anchorService, ipfsService)
    }
    await anchorPendingRequests(requests)

    await requestRepository.findAndMarkReady(0)

    requests = await requestRepository.findByStatus(RequestStatus.READY)
    expect(requests.length).toEqual(numRequests / 2)

    // Second pass anchors the remaining half of the original requests
    await anchorPendingRequests(requests)

    // All requests should have been processed
    const leftOverRequests = await requestRepository.findAndMarkReady(0)
    expect(leftOverRequests.length).toEqual(0)
  })

  test('Anchors in request order', async () => {
    const anchorLimit = 4
    const numStreams = anchorLimit * 2 // twice as many streams as can fit in a batch

    // Create pending requests
    // We want 2 requests per streamId, but don't want the requests on the same stream to be created
    // back-to-back.  So we do one pass to generate the first request for each stream, then another
    // to make the second requests.
    const requests: Request[] = []
    let numFailed = Math.floor(anchorLimit / 2)
    for (let i = 0; i < numStreams; i++) {
      const streamId = await randomStreamID()

      const request =
        numFailed > 0
          ? await createRequest(
              streamId.toString(),
              ipfsService,
              requestRepository,
              RequestStatus.FAILED
            )
          : await createRequest(streamId.toString(), ipfsService, requestRepository)
      numFailed = numFailed - 1

      await requestRepository.createOrUpdate(request)
      requests.push(request)

      // Make sure each stream gets a unique 'createdAt' Date
      await Utils.delay(1000)
    }

    // Second pass, a second request per stream.  Create the 2nd request per stream in the opposite
    // order from how the first request per stream was.
    for (let i = numStreams - 1; i >= 0; i--) {
      const prevRequest = requests[i]
      const streamId = prevRequest.streamId

      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      requests.push(request)
      const stream = createStream(StreamID.fromString(streamId), [
        toCID(prevRequest.cid),
        toCID(request.cid),
      ])
      ceramicService.putStream(StreamID.fromString(streamId), stream)

      // Make sure each stream gets a unique 'createdAt' Date
      await Utils.delay(1000)
    }

    await requestRepository.findAndMarkReady(anchorLimit)

    // First pass anchors half the pending requests
    await expect(requestRepository.countByStatus(RequestStatus.READY)).resolves.toEqual(
      anchorLimit * 2
    )
    const anchorPendingRequests = async function (requests: Request[]): Promise<void> {
      const [candidates, _] = await anchorService._findCandidates(requests, anchorLimit)
      expect(candidates.length).toEqual(anchorLimit)

      await anchorCandidates(candidates, anchorService, ipfsService)
    }
    await anchorPendingRequests(requests)

    await requestRepository.findAndMarkReady(anchorLimit)

    const remainingRequests = await requestRepository.findByStatus(RequestStatus.READY)
    expect(remainingRequests.length).toEqual(requests.length / 2)

    for (let i = 0; i < anchorLimit; i++) {
      // The first 'anchorLimit' requests created should have been anchored, so should not show up
      // as remaining
      const remaining = remainingRequests.find((req) => req.id == requests[i].id)
      expect(remaining).toBeFalsy()
    }

    for (let i = anchorLimit; i < numStreams; i++) {
      // The remaining half of the requests from the first batch created are on streams that
      // weren't included in the batch, and so should still be remaining
      const remaining = remainingRequests.find((req) => req.id == requests[i].id)
      expect(remaining).toBeTruthy()
    }

    for (let i = numStreams; i < numStreams + anchorLimit; i++) {
      // The earlier created requests from the second request batch correspond to the later
      // created streams, and thus should still be remaining
      const remaining = remainingRequests.find((req) => req.id == requests[i].id)
      expect(remaining).toBeTruthy()
    }

    for (let i = numStreams + anchorLimit; i < numStreams * 2; i++) {
      // The later created requests from the second request batch correspond to the earlier
      // created streams, and thus should be anchored and not remaining
      const remaining = remainingRequests.find((req) => req.id == requests[i].id)
      expect(remaining).toBeFalsy()
    }
  }, 30000)

  test('Unlimited anchor requests', async () => {
    const anchorLimit = 0 // 0 means infinity
    const numRequests = 5

    // Create pending requests
    for (let i = 0; i < numRequests; i++) {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const stream = createStream(streamId, [toCID(request.cid)])
      ceramicService.putStream(streamId, stream)
      ceramicService.putStream(commitId, stream)
    }

    await requestRepository.findAndMarkReady(anchorLimit)

    const requests = await requestRepository.findByStatus(RequestStatus.READY)
    expect(requests.length).toEqual(numRequests)
    const [candidates, _] = await anchorService._findCandidates(requests, anchorLimit)
    expect(candidates.length).toEqual(numRequests)
    await anchorCandidates(candidates, anchorService, ipfsService)

    // All requests should have been processed
    const requestsReady = await requestRepository.countByStatus(RequestStatus.READY)
    expect(requestsReady).toEqual(0)
  })

  test('filters invalid requests', async () => {
    const makeRequest = async function (valid: boolean) {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)

      if (valid) {
        const commitId = CommitID.make(streamId, request.cid)
        const stream = createStream(streamId, [toCID(request.cid)])
        ceramicService.putStream(streamId, stream)
        ceramicService.putStream(commitId, stream)
      }

      return request
    }

    const requests: Request[] = []
    for (const isValid of [true, false, true, false]) {
      const request = await makeRequest(isValid)
      requests.push(request)
    }

    // mark requests as ready and move to processing before loading candidates
    const markedAsReady = await requestRepository.findAndMarkReady(0)
    await requestRepository.updateRequests({ status: RequestStatus.PROCESSING }, markedAsReady)

    const [candidates, _] = await anchorService._findCandidates(requests, 0)
    expect(candidates.length).toEqual(2)

    const request0 = await requestRepository.findByCid(toCID(requests[0].cid))
    const request1 = await requestRepository.findByCid(toCID(requests[1].cid))
    const request2 = await requestRepository.findByCid(toCID(requests[2].cid))
    const request3 = await requestRepository.findByCid(toCID(requests[3].cid))
    expect(request0.status).toEqual(RequestStatus.PROCESSING)
    expect(request1.status).toEqual(RequestStatus.FAILED)
    expect(request2.status).toEqual(RequestStatus.PROCESSING)
    expect(request3.status).toEqual(RequestStatus.FAILED)
  })

  test('sends multiquery for missing commits', async () => {
    const makeRequest = async function (streamId: StreamID, includeInBaseStream: boolean) {
      const request = await createRequest(
        streamId.toString(),
        ipfsService,
        requestRepository,
        RequestStatus.PROCESSING
      )
      const commitId = CommitID.make(streamId, request.cid)

      const existingStream = await ceramicService.loadStream(streamId).catch(() => null)
      let streamWithCommit
      if (existingStream) {
        const log = cloneDeep(existingStream.state.log).map(({ cid }) => cid)
        log.push(toCID(request.cid))
        streamWithCommit = createStream(streamId, log)
      } else {
        streamWithCommit = createStream(streamId, [toCID(request.cid)])
      }

      ceramicService.putStream(commitId, streamWithCommit)

      if (includeInBaseStream) {
        ceramicService.putStream(streamId, streamWithCommit)
      }

      return request
    }

    // One stream where 1 commit is present in the stream in ceramic already and one commit is not
    const streamIdA = await randomStreamID()
    const requestA0 = await makeRequest(streamIdA, true)
    const requestA1 = await makeRequest(streamIdA, false)
    // A second stream where both commits are included in the ceramic already
    const streamIdB = await randomStreamID()
    const requestB0 = await makeRequest(streamIdB, true)
    const requestB1 = await makeRequest(streamIdB, true)

    // Set up mock multiquery implementation to make sure that it finds requestA1 in streamA,
    // even though it isn't there in the MockCeramicService
    const commitIdA1 = CommitID.make(streamIdA, requestA1.cid)
    const streamAWithRequest1 = await ceramicService.loadStream(commitIdA1.toString() as any)
    const multiQuerySpy = jest.spyOn(ceramicService, 'multiQuery')
    multiQuerySpy.mockImplementationOnce(async (queries) => {
      const result = {}
      result[streamIdA.toString()] = streamAWithRequest1
      result[commitIdA1.toString()] = streamAWithRequest1
      return result
    })

    const [candidates, _] = await anchorService._findCandidates(
      [requestA0, requestA1, requestB0, requestB1],
      0
    )
    expect(candidates.length).toEqual(2)
    expect(candidates[0].streamId.toString()).toEqual(streamIdA.toString())
    expect(candidates[0].cid.toString()).toEqual(requestA1.cid)
    expect(candidates[1].streamId.toString()).toEqual(streamIdB.toString())
    expect(candidates[1].cid.toString()).toEqual(requestB1.cid)

    // Should only get 1 multiquery, for streamA.  StreamB already had all commits included so no
    // need to issue multiquery
    expect(multiQuerySpy).toHaveBeenCalledTimes(1)
    expect(multiQuerySpy.mock.calls[0][0].length).toEqual(2)
    expect(multiQuerySpy.mock.calls[0][0][0].streamId.toString()).toEqual(commitIdA1.toString())
    expect(multiQuerySpy.mock.calls[0][0][1].streamId.toString()).toEqual(streamIdA.toString())

    multiQuerySpy.mockRestore()
  })

  test('filters anchors that fail to publish AnchorCommit', async () => {
    // Create pending requests
    const numRequests = 4
    for (let i = 0; i < numRequests; i++) {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const stream = createStream(streamId, [toCID(request.cid)])
      ceramicService.putStream(streamId, stream)
      ceramicService.putStream(commitId, stream)
    }

    await requestRepository.findAndMarkReady(numRequests)
    const requests = await requestRepository.findByStatus(RequestStatus.READY)

    expect(requests.length).toEqual(numRequests)
    const [candidates, _] = await anchorService._findCandidates(requests, 0)
    expect(candidates.length).toEqual(numRequests)

    const originalMockDagPut = mockIpfsClient.dag.put.getMockImplementation()
    mockIpfsClient.dag.put.mockImplementation(async (ipfsAnchorCommit) => {
      if (ipfsAnchorCommit.prev && ipfsAnchorCommit.prev.toString() == requests[1].cid.toString()) {
        throw new Error('storing record failed')
      }

      return originalMockDagPut(ipfsAnchorCommit)
    })

    const originalMockPubsubPublish = mockIpfsClient.pubsub.publish.getMockImplementation()
    mockIpfsClient.pubsub.publish.mockImplementation(async (topic, message) => {
      const deserializedMessage = PubsubMessage.deserialize({
        data: message,
      }) as PubsubMessage.UpdateMessage

      if (deserializedMessage.stream.toString() == requests[3].streamId.toString()) {
        throw new Error('publishing update failed')
      }

      return originalMockPubsubPublish(topic, message)
    })

    const anchors = await anchorCandidates(candidates, anchorService, ipfsService)
    expect(anchors.length).toEqual(2)
    expect(anchors.find((anchor) => anchor.requestId == requests[0].id)).toBeTruthy()
    expect(anchors.find((anchor) => anchor.requestId == requests[1].id)).toBeFalsy()
    expect(anchors.find((anchor) => anchor.requestId == requests[2].id)).toBeTruthy()
    expect(anchors.find((anchor) => anchor.requestId == requests[3].id)).toBeFalsy()
  })

  test('will not throw if no anchor commits were created', async () => {
    const requestRepository = injector.resolve('requestRepository')
    const anchorService = injector.resolve('anchorService')

    const anchorLimit = 2
    const numRequests = 2

    // Create pending requests
    for (let i = 0; i < numRequests; i++) {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const stream = createStream(streamId, [toCID(request.cid)])
      ceramicService.putStream(streamId, stream)
      ceramicService.putStream(commitId, stream)
    }

    await requestRepository.findAndMarkReady(anchorLimit)

    const requests = await requestRepository.findByStatus(RequestStatus.READY)
    expect(requests.length).toEqual(numRequests)
    const [candidates, _] = await anchorService._findCandidates(requests, anchorLimit)
    expect(candidates.length).toEqual(numRequests)

    const original = anchorService._createAnchorCommit
    try {
      anchorService._createAnchorCommit = async (candidate) => {
        candidate.failAllRequests()
        return null
      }
      await anchorCandidates(candidates, anchorService, ipfsService)
    } finally {
      anchorService._createAnchorCommit = original
    }
  })

  describe('Picks proper commit to anchor', () => {
    test('Anchor more recent of two commits', async () => {
      // 1 stream with 2 pending requests, one request is newer and inclusive of the other.
      const streamId = await randomStreamID()
      const request0 = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const request1 = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId0 = CommitID.make(streamId, request0.cid)
      const commitId1 = CommitID.make(streamId, request1.cid)

      // request1 is the most recent tip
      ceramicService.putStream(commitId0, createStream(streamId, [toCID(request0.cid)]))
      ceramicService.putStream(
        commitId1,
        createStream(streamId, [toCID(request0.cid), toCID(request1.cid)])
      )
      ceramicService.putStream(
        streamId,
        createStream(streamId, [toCID(request0.cid), toCID(request1.cid)])
      )

      const [candidates, _] = await anchorService._findCandidates([request0, request1], 0)
      const anchors = await anchorCandidates(candidates, anchorService, ipfsService)
      expect(candidates.length).toEqual(1)
      const candidate = candidates[0]
      expect(candidate.streamId).toEqual(streamId)
      expect(candidate.cid.toString()).toEqual(request1.cid)

      // Both requests should be marked as completed
      const updatedRequest0 = await requestRepository.findByCid(toCID(request0.cid))
      const updatedRequest1 = await requestRepository.findByCid(toCID(request1.cid))
      expect(updatedRequest0.status).toEqual(RequestStatus.COMPLETED)
      expect(updatedRequest1.status).toEqual(RequestStatus.COMPLETED)

      // Anchor should have selected request1's CID
      expect(anchors.length).toEqual(1)
      const anchor = anchors[0]
      const anchorCommit = await ipfsService.retrieveRecord(anchor.cid)
      expect(anchorCommit.prev.toString()).toEqual(request1.cid)
      expect(anchor.requestId).toEqual(request1.id)
    })

    test('Anchors commit more recent than any requests', async () => {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const tipCID = await ipfsService.storeRecord({})

      // The most recent tip doesn't have a corresponding request, but includes the pending
      // request CID.
      ceramicService.putStream(commitId, createStream(streamId, [toCID(request.cid)]))
      ceramicService.putStream(streamId, createStream(streamId, [toCID(request.cid), tipCID]))

      const [candidates, _] = await anchorService._findCandidates([request], 0)
      const anchors = await anchorCandidates(candidates, anchorService, ipfsService)
      expect(candidates.length).toEqual(1)
      const candidate = candidates[0]
      expect(candidate.streamId).toEqual(streamId)
      expect(candidate.cid.toString()).toEqual(tipCID.toString())

      // request should be marked as completed
      const updatedRequest = await requestRepository.findByCid(toCID(request.cid))
      expect(updatedRequest.status).toEqual(RequestStatus.COMPLETED)

      // Anchor should have selected tipCID
      expect(anchors.length).toEqual(1)
      const anchor = anchors[0]
      const anchorCommit = await ipfsService.retrieveRecord(anchor.cid)
      expect(anchorCommit.prev.toString()).toEqual(tipCID.toString())
      // The request should still have been marked in the anchor database
      expect(anchor.requestId).toEqual(request.id)
    })

    test('No anchor performed if no valid requests', async () => {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const tipCID = await ipfsService.storeRecord({})

      // The most recent tip doesn't have a corresponding request, and does *not* include the pending
      // request CID.
      ceramicService.putStream(commitId, createStream(streamId, [toCID(request.cid)]))
      ceramicService.putStream(streamId, createStream(streamId, [tipCID]))

      const [candidates, _] = await anchorService._findCandidates([request], 0)
      expect(candidates.length).toEqual(0)
      const updatedRequest = await requestRepository.findByCid(toCID(request.cid))
      expect(updatedRequest.status).toEqual(RequestStatus.FAILED)
    })

    test('Request succeeds without anchor for already anchored CIDs', async () => {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      const commitId = CommitID.make(streamId, request.cid)
      const anchorCommitCID = await ipfsService.storeRecord({})

      // The most recent tip doesn't have a corresponding request, but includes the pending
      // request CID.
      ceramicService.putStream(commitId, createStream(streamId, [toCID(request.cid)]))
      ceramicService.putStream(
        streamId,
        createStream(streamId, [toCID(request.cid), anchorCommitCID], AnchorStatus.ANCHORED)
      )

      const [candidates, _] = await anchorService._findCandidates([request], 0)
      expect(candidates.length).toEqual(0)

      // request should still be marked as completed even though no anchor was performed
      const updatedRequest = await requestRepository.findByCid(toCID(request.cid))
      expect(updatedRequest.status).toEqual(RequestStatus.COMPLETED)
    })

    test('Request succeeds without anchor if subsequent CIDs are already anchored', async () => {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      await requestRepository.createOrUpdate(request)
      const commitId = CommitID.make(streamId, request.cid)

      const nextRequest = await createRequest(streamId.toString(), ipfsService, requestRepository)
      await requestRepository.createOrUpdate(request)
      const nextCommitId = CommitID.make(streamId, request.cid)
      const anchorCommitCID = await ipfsService.storeRecord({})

      const nextNextRequest = await createRequest(
        streamId.toString(),
        ipfsService,
        requestRepository
      )
      await requestRepository.createOrUpdate(request)
      const nextNextCommitId = CommitID.make(streamId, request.cid)

      ceramicService.putStream(
        commitId,
        createStream(streamId, [{ cid: toCID(request.cid), type: CommitType.GENESIS }])
      )
      ceramicService.putStream(
        nextCommitId,
        createStream(streamId, [
          { cid: toCID(request.cid), type: CommitType.GENESIS },
          { cid: toCID(nextRequest.cid), type: CommitType.SIGNED },
        ])
      )
      ceramicService.putStream(
        nextNextCommitId,
        createStream(streamId, [
          { cid: toCID(request.cid), type: CommitType.GENESIS },
          { cid: toCID(nextRequest.cid), type: CommitType.SIGNED },
          { cid: anchorCommitCID, type: CommitType.ANCHOR },
          { cid: toCID(nextNextRequest.cid), type: CommitType.SIGNED },
        ])
      )
      ceramicService.putStream(
        streamId,
        createStream(
          streamId,
          [
            { cid: toCID(request.cid), type: CommitType.GENESIS },
            { cid: toCID(nextRequest.cid), type: CommitType.SIGNED },
            { cid: anchorCommitCID, type: CommitType.ANCHOR },
            { cid: toCID(nextNextRequest.cid), type: CommitType.SIGNED },
          ],
          AnchorStatus.PENDING
        )
      )

      const [candidates, _] = await anchorService._findCandidates([request], 0)
      expect(candidates.length).toEqual(0)

      // request should still be marked as completed even though no anchor was performed
      const updatedRequest = await requestRepository.findByCid(toCID(request.cid))
      expect(updatedRequest.status).toEqual(RequestStatus.COMPLETED)
    })

    test('Request succeeds for anchor requests that have been anchored but not updated to COMPLETE', async () => {
      const streamId = await randomStreamID()
      const request = await createRequest(streamId.toString(), ipfsService, requestRepository)
      await requestRepository.createOrUpdate(request)
      const commitId0 = CommitID.make(streamId, request.cid)

      ceramicService.putStream(commitId0, createStream(streamId, [toCID(request.cid)]))
      ceramicService.putStream(streamId, createStream(streamId, [toCID(request.cid)]))

      const [candidates] = await anchorService._findCandidates([request], 0)
      await anchorCandidates(candidates, anchorService, ipfsService)
      const updatedRequest = await requestRepository.findByCid(toCID(request.cid))
      expect(updatedRequest.status).toEqual(RequestStatus.COMPLETED)

      await requestRepository.updateRequests({ status: RequestStatus.PENDING }, [updatedRequest])

      // request should not be a candidate again because it already has an anchor
      const [candidates2] = await anchorService._findCandidates([request], 0)
      expect(candidates2.length).toEqual(0)
      const updatedRequest2 = await requestRepository.findByCid(toCID(request.cid))
      expect(updatedRequest2.status).toEqual(RequestStatus.COMPLETED)
    })
  })

  describe('Request pinning', () => {
    async function anchorRequests(numRequests: number): Promise<Request[]> {
      // Create Requests
      const streamIds = Array.from({ length: numRequests }).map(() => randomStreamID())
      const requests = await Promise.all(
        streamIds.map((streamId) =>
          createRequest(streamId.toString(), ipfsService, requestRepository)
        )
      )

      // Create streams in Ceramic
      for (let i = 0; i < numRequests; i++) {
        const request = requests[i]
        const streamId = streamIds[i]
        const commitId = CommitID.make(streamId, request.cid)

        const stream = createStream(streamId, [toCID(request.cid)])
        ceramicService.putStream(commitId, stream)
        ceramicService.putStream(streamId, stream)
      }

      const [candidates, _] = await anchorService._findCandidates(requests, 0)
      await anchorCandidates(candidates, anchorService, ipfsService)
      expect(candidates.length).toEqual(numRequests)

      return requests
    }

    test('Successful anchor pins request', async () => {
      const [request0] = await anchorRequests(1)

      // Request should be marked as completed and pinned
      const updatedRequest0 = await requestRepository.findByCid(toCID(request0.cid))
      expect(updatedRequest0.status).toEqual(RequestStatus.COMPLETED)
      expect(updatedRequest0.cid).toEqual(request0.cid)
      expect(updatedRequest0.message).toEqual('CID successfully anchored.')
      expect(updatedRequest0.pinned).toEqual(true)

      console.log(updatedRequest0.updatedAt.toISOString())
    })

    test('Request garbage collection', async () => {
      const requestCIDs = (await anchorRequests(3)).map((request) => request.cid)
      const requests = await Promise.all(
        requestCIDs.map((cid) => requestRepository.findByCid(toCID(cid)))
      )

      const now = new Date()
      const TWO_MONTHS = 1000 * 60 * 60 * 24 * 60
      const expiredDate = new Date(now.getTime() - TWO_MONTHS)

      // Make 2 of the 3 requests be expired
      requests[0].updatedAt = expiredDate
      requests[1].updatedAt = expiredDate
      await requestRepository.createOrUpdate(requests[0])
      await requestRepository.createOrUpdate(requests[1])

      // run garbage collection
      const unpinStreamSpy = jest.spyOn(ceramicService, 'unpinStream')
      await anchorService.garbageCollectPinnedStreams()

      const updatedRequests = await Promise.all(
        requests.map((req) => requestRepository.findByCid(toCID(req.cid)))
      )
      // Expired requests should be unpinned, but recent request should still be pinned
      expect(updatedRequests[0].pinned).toBeFalsy()
      expect(updatedRequests[1].pinned).toBeFalsy()
      expect(updatedRequests[2].pinned).toBeTruthy()
      expect(unpinStreamSpy).toHaveBeenCalledTimes(2)

      // Running garbage collection on already unpinned streams shouldn't unpin again
      updatedRequests[0].updatedAt = expiredDate
      await requestRepository.createOrUpdate(updatedRequests[0])
      await anchorService.garbageCollectPinnedStreams()

      const finalRequests = await Promise.all(
        updatedRequests.map((req) => requestRepository.findByCid(toCID(req.cid)))
      )
      expect(finalRequests[0].pinned).toBeFalsy()
      expect(finalRequests[1].pinned).toBeFalsy()
      expect(finalRequests[2].pinned).toBeTruthy()
      // No additional calls to unpinStream
      expect(unpinStreamSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('emitAnchorEventIfReady', () => {
    test('Does not emit if ready requests exist but they are not timed out', async () => {
      const originalRequests = [
        generateRequests(
          {
            status: RequestStatus.READY,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          2
        ),
        generateRequests(
          {
            status: RequestStatus.PENDING,
          },
          4
        ),
      ].flat()

      const withConnectionSpy = jest.spyOn(requestRepository, 'withConnection')
      withConnectionSpy.mockImplementationOnce(() => requestRepository)
      const requestRepositoryUpdateSpy = jest.spyOn(requestRepository, 'updateRequests')

      try {
        await requestRepository.createRequests(originalRequests)
        await anchorService.emitAnchorEventIfReady()

        expect(requestRepositoryUpdateSpy).toHaveBeenCalledTimes(0)
        expect(eventProducerService.emitAnchorEvent.mock.calls.length).toEqual(0)
      } finally {
        requestRepositoryUpdateSpy.mockRestore()
      }
    })

    test('Emits an event if ready requests exist but they have timed out', async () => {
      const config = injector.resolve('config')
      const updatedTooLongAgo = new Date(Date.now() - config.readyRetryIntervalMS - 1000)
      // Ready requests that have timed out (created too long ago)
      const originalRequests = generateRequests(
        {
          status: RequestStatus.READY,
          createdAt: updatedTooLongAgo,
          updatedAt: updatedTooLongAgo,
        },
        3,
        0
      )

      const withConnectionSpy = jest.spyOn(requestRepository, 'withConnection')
      withConnectionSpy.mockImplementationOnce(() => requestRepository)
      const requestRepositoryUpdateSpy = jest.spyOn(requestRepository, 'updateRequests')

      await requestRepository.createRequests(originalRequests)

      await anchorService.emitAnchorEventIfReady()

      expect(requestRepositoryUpdateSpy).toHaveBeenCalledTimes(1)

      const updatedRequests = await requestRepository.findByStatus(RequestStatus.COMPLETED)

      expect(updatedRequests.every(({ updatedAt }) => updatedAt > updatedTooLongAgo)).toEqual(true)

      expect(eventProducerService.emitAnchorEvent.mock.calls.length).toEqual(1)
      expect(validateUUID(eventProducerService.emitAnchorEvent.mock.calls[0][0])).toEqual(true)
      requestRepositoryUpdateSpy.mockRestore()
    })

    test('does not emit if no requests were updated to ready', async () => {
      // not enough request generated
      const originalRequests = generateRequests(
        {
          status: RequestStatus.PENDING,
        },
        MIN_STREAM_COUNT - 1
      )

      await requestRepository.createRequests(originalRequests)
      await anchorService.emitAnchorEventIfReady()
      expect(eventProducerService.emitAnchorEvent.mock.calls.length).toEqual(0)
    })

    test('emits if requests were updated to ready', async () => {
      const originalRequests = generateRequests(
        {
          status: RequestStatus.PENDING,
        },
        STREAM_LIMIT
      )

      await requestRepository.createRequests(originalRequests)
      await anchorService.emitAnchorEventIfReady()

      expect(eventProducerService.emitAnchorEvent.mock.calls.length).toEqual(1)
      expect(validateUUID(eventProducerService.emitAnchorEvent.mock.calls[0][0])).toEqual(true)

      const updatedRequests = await requestRepository.findByStatus(RequestStatus.READY)
      expect(updatedRequests.map(({ cid }) => cid).sort()).toEqual(
        originalRequests.map(({ cid }) => cid).sort()
      )
    })

    test('Does not crash if the event producer rejects', async () => {
      const originalRequests = generateRequests(
        {
          status: RequestStatus.PENDING,
        },
        STREAM_LIMIT
      )

      eventProducerService.emitAnchorEvent = jest.fn(() => {
        return Promise.reject('test error')
      })

      await requestRepository.createRequests(originalRequests)
      await anchorService.emitAnchorEventIfReady()
    })

    test('Does not retry requests that are being updated simultaneously', async () => {
      const config = injector.resolve('config')
      const updatedTooLongAgo = new Date(Date.now() - config.readyRetryIntervalMS - 1000)

      // Ready requests that have timed out (created too long ago)
      const requests = generateRequests(
        {
          status: RequestStatus.READY,
          createdAt: updatedTooLongAgo,
          updatedAt: updatedTooLongAgo,
        },
        3,
        0
      )

      await requestRepository.createRequests(requests)
      const createdRequests = await requestRepository.findByStatus(RequestStatus.READY)

      await Promise.all([
        requestRepository.updateRequests(
          { status: RequestStatus.COMPLETED, message: 'request0' },
          createdRequests.slice(0, 1)
        ),
        requestRepository.updateRequests(
          { status: RequestStatus.PENDING, message: 'request1' },
          createdRequests.slice(1, 2)
        ),
        requestRepository.updateRequests(
          { status: RequestStatus.FAILED, message: 'request2' },
          createdRequests.slice(2)
        ),
        anchorService.emitAnchorEventIfReady(),
      ])

      const updatedRequestsCount = await requestRepository.countByStatus(RequestStatus.READY)
      expect(updatedRequestsCount).toEqual(0)
      expect(eventProducerService.emitAnchorEvent.mock.calls.length).toEqual(0)
    })
  })
})
