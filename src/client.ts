import { isEqual } from 'lodash';
import dotenv from 'dotenv';
import {
  ApiXClient,
  ApiXHttpMethod,
  ApiXRequest,
  ApiXRequestHeaders,
  ApiXResponse,
  ApiXEncryptedKeyStore,
  ApiXSymmetricEncryptionService,
  KeyProvider,
  ApiXResponseError,
  ApiXResponseInvalidRequestError,
  ApiXResponseInvalidJsonBodyError,
  ApiXRequestError,
  ApiXResponseUnauthorizedRequestError
} from '@evlt/apix-client';

dotenv.config();

class KeyProviderImpl implements KeyProvider {
  public getKey(): string {
    return process.env.KEY!;
  }
}

class ApiXIntegClient {
  public authToken?: string;
  private client: ApiXClient;

  constructor(apiKey: string, appKey: string) {
    const keyProvider = new KeyProviderImpl();
    const keyStore = new ApiXEncryptedKeyStore(
      new ApiXSymmetricEncryptionService('fast'),
      keyProvider,
      apiKey,
      appKey
    );
    this.client = new ApiXClient(keyStore);
  }

  public request(
    url: string,
    httpMethod: ApiXHttpMethod,
    jsonBody?: Record<string, unknown>
  ): ApiXRequest {
    const request = this.client.createRequest(
      new URL(url),
      httpMethod,
      jsonBody
    );

    if (this.authToken) {
      request.setHeader(ApiXRequestHeaders.Authorization, `Bearer ${this.authToken}`);
    }

    /// Fake https
    request.setHeader('X-Forwarded-Proto', 'https');

    return request;
  }

  public async makeRequest(request: ApiXRequest): Promise<ApiXResponse> {
    return await request.make();
  }
}

interface TestSequence {
  readonly run: (client: ApiXIntegClient, lastRequest?: ApiXRequest) => Promise<[ApiXRequest, ApiXResponse]>;
  readonly expectedResponse?: ApiXResponse<any>;
  readonly expectedError?: {
    readonly id?: string;
    readonly statusCode?: number;
    readonly message: string;
    readonly classType?: new (...args: any[]) => Error;
  }
}

class TestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestError';
  }
}

class TestSequenceRunner {
  private client: ApiXIntegClient;
  constructor(private sequences: TestSequence[]) {
    this.client = new ApiXIntegClient(
      process.env.API_KEY ?? '',
      process.env.APP_KEY ?? ''
    );
  }

  public async run() {
    let lastRequest: ApiXRequest | undefined;
    let counter = 1;
    const length = this.sequences.length;
    for (const sequence of this.sequences) {
      console.log(`Running test [${counter}/${length}]...`);
      try {
        const [request, response] = await sequence.run(this.client, lastRequest);
        lastRequest = request;

        if (sequence.expectedError) {
          throw new TestError(`Expected error but got response: ${JSON.stringify(response)}.`);
        }

        if (!isEqual(response, sequence.expectedResponse)) {
          throw new TestError(`Expected response and actual response are different: ${JSON.stringify(sequence.expectedResponse)} !== ${JSON.stringify(response)}`)
        }
      } catch (error) {
        if (error instanceof TestError) {
          throw error;  // Re-throw TestError to stop the sequence
        }

        if (!(error instanceof Error) || !this.errorsMatch(error, sequence.expectedError!)) {
            throw new TestError(`Expected error ${sequence.expectedError?.classType!.name}: ${JSON.stringify(sequence.expectedError)} but got: ${error}`);
        }
      }
      counter += 1;
    }
  }

  private errorsMatch(error: Error, expectedError: TestSequence['expectedError']): boolean {
    if (!expectedError || !expectedError.classType || !expectedError.message) {
      return false;
    }

    if (error instanceof ApiXRequestError) {
      /// Only message and type need to match.
      return error instanceof expectedError.classType
        && error.message === expectedError.message;
    }

    if (error instanceof ApiXResponseError) {
      /// Message, id, type, and statusCode need to match.
      return error instanceof expectedError.classType
        && error.message === expectedError.message
        && error.id === expectedError.id
        && error.statusCode === expectedError.statusCode;
    }

    return false;
  }
}

const runner = new TestSequenceRunner([
  {
    run: async (client, lastRequest) => {
      const request = client.request(
        'http://localhost:3000/cache/add',
        'PUT',
        {
          key: 'myKey',
          value: 980
        }
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      data: {
        success: true,
        message: `Set value for key 'myKey'`
      },
      statusCode: 200
    }
  },
  {
    run: async (client, lastRequest) => {
      const request = client.request(
        'http://localhost:3000/cache/myKey',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      data: {
        success: true,
        value: 980
      },
      statusCode: 200
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Repeat request should be rejected
      const request = lastRequest!;
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      message: 'This request has already been sent. API-X does not allow attempting to send the same request multiple times.',
      classType: ApiXRequestError
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Old requests are rejected
      const request = client.request(
        'http://localhost:3000/cache/myKey',
        'GET'
      );
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      id: 'invalidRequest',
      message: 'This request is not valid.',
      classType: ApiXResponseInvalidRequestError,
      statusCode: 401
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Invalid signatures are rejected
      const request = client.request(
        'http://localhost:3000/cache/myKey',
        'GET'
      );

      request['initializeProtectedHeaders'] = (apiKey: string, appKey: string) => {
        request['protectedHeaders']['x-api-key'] = apiKey;
        request['protectedHeaders']['x-signature'] = 'invalidSignature';
        request['protectedHeaders']['x-signature-nonce'] = 'some-nonce';
      };

      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      id: 'invalidRequest',
      message: 'This request is not valid.',
      classType: ApiXResponseInvalidRequestError,
      statusCode: 401
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Invalid credentials login
      const request = client.request(
        'http://localhost:3000/login',
        'POST',
        {
          username: 'someInvalidUsername@invalid.com',
          password: 'HELLO0Invalid'
        }
      );
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      id: 'Unauthorized',
      message: 'Invalid username or password.',
      classType: ApiXResponseError,
      statusCode: 403
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Get quotes without authentication!
      const request = client.request(
        'http://localhost:3000/quotes/0',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      statusCode: 401,
      id: 'unauthorizedRequest',
      message: 'This request is not authorized.',
      classType: ApiXResponseUnauthorizedRequestError
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Login with valid credentials
      const request = client.request(
        'http://localhost:3000/login',
        'POST',
        {
          username: process.env.USERNAME,
          password: process.env.PASSWORD
        }
      );
      const response = await client.makeRequest(request);
      client.authToken = (response.data as any)?.authToken as string;
      delete (response.data as any)?.authToken;
      return [request, response];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Get quotes
      const request = client.request(
        'http://localhost:3000/quotes/0',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        quote: {
          id: '0',
          content: 'I think, therefore I am.',
          author: 'René Descartes',
          date: '1637',
          ownerUserId: 'apix@evoluti.us'
        }
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Add quotes with invalid body
      const request = client.request(
        'http://localhost:3000/quotes/add',
        'PUT',
        {
          content: 'Why is Gamora?---***',
          author: 'Drax the Destroyer',
          date: '2018',
          ownerUserId: 'apix@evoluti.us'
        }
      );
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      id: 'invalidJsonBody',
      message: 'Invalid request. Invalid HTTP body.',
      classType: ApiXResponseInvalidJsonBodyError,
      statusCode: 400
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Add quotes
      const request = client.request(
        'http://localhost:3000/quotes/add',
        'PUT',
        {
          content: 'Why is Gamora?',
          author: 'Drax the Destroyer',
          date: '2018'
        }
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        quote: {
          id: '9',
          content: 'Why is Gamora?',
          author: 'Drax the Destroyer',
          date: '2018',
          ownerUserId: 'newb'
        }
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Get quotes
      const request = client.request(
        'http://localhost:3000/quotes/9',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        quote: {
          id: '9',
          content: 'Why is Gamora?',
          author: 'Drax the Destroyer',
          date: '2018',
          ownerUserId: 'newb'
        }
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Delete quotes
      const request = client.request(
        'http://localhost:3000/quotes/delete',
        'DELETE',
        {
          quoteId: '9'
        }
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        message: 'Successfully deleted quote with ID 9'
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Delete quotes
      const request = client.request(
        'http://localhost:3000/quotes/delete',
        'DELETE',
        {
          quoteId: '9'
        }
      );
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      id: 'NotFound',
      message: 'No quote with ID 9 found.',
      statusCode: 404,
      classType: ApiXResponseError
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Search quotes: invalid due to missing required `searchTerm`
      const request = client.request(
        'http://localhost:3000/quotes/search?sortBy=date&ascendingSort=true&author=William Shakespeare',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedError: {
      id: 'invalidRequestParameters',
      message: 'Missing required parameter searchTerm',
      classType: ApiXResponseError,
      statusCode: 400
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Search quotes
      const request = client.request(
        'http://localhost:3000/quotes/search?searchTerm=live&sortKey=date',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        quotes: [
          {
            id: '7',
            content: 'I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived.',
            author: 'Henry David Thoreau',
            date: '1854',
            ownerUserId: 'apix@evoluti.us'
          }
        ]
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Search quotes
      const request = client.request(
        'http://localhost:3000/quotes/search?searchTerm=the&author=William Shakespeare&sortKey=date&ascendingSort=true',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        quotes: [
          {
            id: '8',
            content: 'All the world’s a stage, and all the men and women merely players.',
            author: 'William Shakespeare',
            date: '1599',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '2',
            content: 'To be, or not to be, that is the question.',
            author: 'William Shakespeare',
            date: '1600',
            ownerUserId: 'apix@evoluti.us'
          },
        ]
      }
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Search quotes
      const request = client.request(
        'http://localhost:3000/quotes/search?searchTerm= &sortKey=author&ascendingSort=false',
        'GET'
      );
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      statusCode: 200,
      data: {
        success: true,
        quotes: [
          {
            id: '2',
            content: 'To be, or not to be, that is the question.',
            author: 'William Shakespeare',
            date: '1600',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '8',
            content: 'All the world’s a stage, and all the men and women merely players.',
            author: 'William Shakespeare',
            date: '1599',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '3',
            content: 'The unexamined life is not worth living.',
            author: 'Socrates',
            date: '399 BCE',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '0',
            content: 'I think, therefore I am.',
            author: 'René Descartes',
            date: '1637',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '4',
            content: 'Give me liberty, or give me death!',
            author: 'Patrick Henry',
            date: 'March 23, 1775',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '6',
            content: 'Injustice anywhere is a thread to justice everywhere.',
            author: 'Martin Luther King Jr.',
            date: 'April 16, 1963',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '7',
            content: 'I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived.',
            author: 'Henry David Thoreau',
            date: '1854',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '1',
            content: 'The only thing we have to fear is fear itself.',
            author: 'Franklin D. Roosevelt',
            date: 'March 4, 1933',
            ownerUserId: 'apix@evoluti.us'
          },
          {
            id: '5',
            content: 'Hisashiburi da na, Mugiwara.',
            author: 'Crocodile',
            date: '800 PVC',
            ownerUserId: 'apix@evoluti.us'
          }
        ]
      }
    }
  },
]);

runner.run()
  .then(() => {
    console.log(`\x1b[32mSuccess! All tests passed!\x1b[0m`);
  })
  .catch((error) => {
    console.error(`\x1b[31mTests failed:`);
    console.error(`${error}\x1b[0m`);
    process.exitCode = 1;
  });
