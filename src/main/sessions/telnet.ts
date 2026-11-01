/**
 * Minimal TELNET (RFC 854) filter.
 *
 * A raw socket is not enough: servers open with IAC option negotiation, and those
 * bytes render as garbage in a terminal. We strip the command stream and answer
 * negotiation by refusing everything except ECHO and SUPPRESS-GO-AHEAD, which is
 * what interactive clients do.
 */
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

const ECHO = 1
const SUPPRESS_GO_AHEAD = 3

type State = 'data' | 'iac' | 'option' | 'subnegotiation' | 'subnegotiationIac'

export class TelnetFilter {
  private state: State = 'data'
  private command = 0

  /** Returns terminal text plus any negotiation replies to send back. */
  process(chunk: Buffer): { text: Buffer; replies: Buffer[] } {
    const bytes: number[] = []
    const replies: Buffer[] = []

    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) this.state = 'iac'
          else bytes.push(byte)
          break

        case 'iac':
          if (byte === IAC) {
            bytes.push(IAC)
            this.state = 'data'
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.command = byte
            this.state = 'option'
          } else if (byte === SB) {
            this.state = 'subnegotiation'
          } else {
            this.state = 'data'
          }
          break

        case 'option': {
          const option = byte
          this.state = 'data'
          const accepts = option === ECHO || option === SUPPRESS_GO_AHEAD
          if (this.command === WILL) {
            replies.push(Buffer.from([IAC, accepts ? DO : DONT, option]))
          } else if (this.command === DO) {
            replies.push(Buffer.from([IAC, accepts ? WILL : WONT, option]))
          }
          break
        }

        case 'subnegotiation':
          if (byte === IAC) this.state = 'subnegotiationIac'
          break

        case 'subnegotiationIac':
          this.state = byte === SE ? 'data' : 'subnegotiation'
          break
      }
    }

    return { text: Buffer.from(bytes), replies }
  }
}
