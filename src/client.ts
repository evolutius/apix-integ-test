import { createHmac } from 'crypto';
import { isEqual, omit } from 'lodash';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

interface Request {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly url: string,
  readonly data?: object,
  readonly headers: Record<string, string>
}

class ApiXClient {
  public authToken?: string;

  constructor(private apiKey: string, private appKey: string) {}

  private generateNonce(length: number = 16): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let nonce = '';
      for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        nonce += characters[randomIndex];
      }
      return nonce;
  }

  private generateSignature(
    key: string,
    endpointPath: string,
    dateString: string,
    nonce: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    httpBody: Record<string, unknown> = {}
  ) {
    const hmac = createHmac('sha256', key);
    const stringifiedJsonBody = Object.keys(httpBody).length > 0
      ? JSON.stringify(httpBody, Object.keys(httpBody).sort())
      : '';
    const httpBodyBase64 = stringifiedJsonBody.length > 0
      ? Buffer.from(stringifiedJsonBody, 'binary').toString('base64')
      : '';
    const message = `${endpointPath}.${method}.${nonce}.${dateString}.${httpBodyBase64}`;
    return hmac
      .update(message, 'utf-8')
      .digest()
      .toString('hex');
  }

  private getRequestHeaders(
    path: string,
    httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    data: Record<string, unknown> = {}
  ): Record<string, string> {
    const nonce = this.generateNonce();
    const date = new Date();
    const sig = this.generateSignature(
      this.appKey,
      path,
      date.toUTCString(),
      nonce,
      httpMethod,
      data
    );
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'X-Signature': sig,
      'X-Signature-Nonce': nonce,
      Date: date.toUTCString(),
      Authorization: this.authToken ? `Bearer ${this.authToken}` : '',
      'X-Forwarded-Proto': 'https' /// Fake HTTPS
    }
  }

  private extractPathFromUrl(url: string): string {
    try {
      const parsedUrl = new URL(url); // Parse the URL
      return parsedUrl.pathname;     // Extract the pathname
    } catch (error) {
      console.error('Invalid URL:', error);
      throw new Error('Failed to parse URL');
    }
} 

  public request(
    url: string,
    httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    jsonBody?: Record<string, unknown>
  ): Request {
    return {
      method: httpMethod,
      url,
      data: jsonBody,
      headers: this.getRequestHeaders(
        this.extractPathFromUrl(url),
        httpMethod,
        jsonBody
      )
    };
  }

  public async makeRequest(request: Request): Promise<Record<string, unknown>> {
    try {
      const response = await axios(request);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        return error.response?.data;
      } else {
        throw error;
      }
    }
  }
}

interface TestSequence {
  readonly run: (client: ApiXClient, lastRequest?: Request) => Promise<[Request, Record<string, unknown>]>; 
  readonly expectedResponse: Record<string, unknown>;
}

class TestSequenceRunner {
  private client: ApiXClient;
  constructor(private sequences: TestSequence[]) {
    this.client = new ApiXClient(
      process.env.API_KEY ?? '',
      process.env.APP_KEY ?? ''
    );
  }

  public async run() {
    let lastRequest: Request | undefined;
    let counter = 1;
    const length = this.sequences.length;
    for (const sequence of this.sequences) {
      console.log(`Running test [${counter}/${length}]...`);
      const [request, response] = await sequence.run(this.client, lastRequest);
      lastRequest = request;
      if (!isEqual(response, sequence.expectedResponse)) {
        throw new Error(`Expected response and actual response are different: ${JSON.stringify(sequence.expectedResponse)} !== ${JSON.stringify(response)}`)
      }
      counter += 1;
    }
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
      success: true,
      message: `Set value for key 'myKey'`
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
      success: true,
      value: 980
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Repeat request should be rejected
      const request = lastRequest!;
      return [request, await client.makeRequest(request)];
    },
    expectedResponse: {
      success: false,
      message: 'This request is not valid.'
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
    expectedResponse: {
      success: false,
      message: 'This request is not valid.'
    }
  },
  {
    run: async (client, lastRequest) => {
      /// Invalid signatures are rejected
      const request = client.request(
        'http://localhost:3000/cache/myKey',
        'GET'
      );
      const newRequest: Request = {
        ...request,
        headers: {
          ...request.headers,
          'X-Signature': 'invalidSignature'
        }
      };
      return [newRequest, await client.makeRequest(newRequest)];
    },
    expectedResponse: {
      success: false,
      message: 'This request is not valid.'
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
    expectedResponse: {
      success: false,
      message: 'Invalid username or password.'
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
    expectedResponse: {
      success: false,
      message: 'This request is not authorized.'
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
      client.authToken = response.authToken as string;
      return [request, omit(response, ['authToken'])];
    },
    expectedResponse: {
      success: true
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
      success: true,
      quote: {
        id: '0',
        content: 'I think, therefore I am.',
        author: 'René Descartes',
        date: '1637',
        ownerUserId: 'apix@evoluti.us'
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
    expectedResponse: {
      success: false,
      message: 'Invalid request. Invalid HTTP body.'
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
      success: true,
      quote: {
        id: '9',
        content: 'Why is Gamora?',
        author: 'Drax the Destroyer',
        date: '2018',
        ownerUserId: 'newb'
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
      success: true,
      quote: {
        id: '9',
        content: 'Why is Gamora?',
        author: 'Drax the Destroyer',
        date: '2018',
        ownerUserId: 'newb'
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
      success: true,
      message: 'Successfully deleted quote with ID 9'
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
      success: false,
      message: 'No quote with ID 9 found.'
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
    expectedResponse: {
      success: false,
      message: 'Missing required parameter searchTerm'
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
