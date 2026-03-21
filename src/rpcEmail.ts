class RPCEmailMessage implements ForwardableEmailMessage {
    readonly from: string;
    readonly to: string;
    readonly rawEmail: string;
    readonly raw: ReadableStream<Uint8Array>;
    readonly headers: Headers;
    readonly rawSize: number;

    constructor(from: string, to: string, rawEmail: string, headers: Headers) {
        this.from = from;
        this.to = to;
        this.rawEmail = rawEmail;
        this.raw = RPCEmailMessage.stringToStream(rawEmail);
        this.rawSize = new TextEncoder().encode(rawEmail).length;
        this.headers = headers;
      }

    static stringToStream(str: string): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(str));
            controller.close();
          }
        });
      }

    setReject(reason: string): void {
        console.log(`rpcEmail default implementation: Message rejected: ${reason}`);
    }

    async forward(rcptTo: string, headers: Headers = new Headers()): Promise<EmailSendResult> {
        console.log(`rpcEmail default implementation: Forwarding message to: ${rcptTo}, with headers:`, headers);
        return { messageId: "rpc-email-forward-not-implemented" };
    }

    async reply(message: EmailMessage): Promise<EmailSendResult> {
        console.log(`rpcEmail default implementation: Replying to: ${message}`);
        return { messageId: "rpc-email-reply-not-implemented" };
    }
}

export { RPCEmailMessage };
