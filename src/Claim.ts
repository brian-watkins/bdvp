import { Failure } from "./Reporter.js"
import { addInvalid, addSkipped, addValid, combineSummaries, emptySummary, Summary } from "./Summary.js"
import { waitFor } from "./waitFor.js"

export interface Claim<T> {
  description: string
  validate(context: T): Promise<ClaimResult>
  skip(): ClaimResult
}

export class SimpleClaim<T> implements Claim<T> {
  constructor(public description: string, private execute: (context: T) => void | Promise<void>) {}
  
  async validate(context: T): Promise<ClaimResult> {
    try {
      await waitFor(this.execute(context))
      return new ValidClaim(this.description)
    } catch (failure: any) {
      return new InvalidClaim(this.description, failure)
    }
  }

  skip(): ClaimResult {
    return new SkippedClaim(this.description)
  }
}

export abstract class ComplexClaim<T> implements Claim<T> {
  constructor(public description: string, private claims: Array<Claim<T>>) {}

  abstract evaluateSubsumedClaim(claim: Claim<T>, context: T): Promise<ClaimResult>

  async validate(context: T): Promise<ClaimResult> {
    let result = new ValidClaim(this.description)

    for (const claim of this.claims) {
      const claimResult = await this.evaluateSubsumedClaim(claim, context)
      result = result.subsume(claimResult)
    }

    return result
  }

  skip(): ClaimResult {
    let result = new SkippedClaim(this.description)

    for (const claim of this.claims) {
      const skippedResult = claim.skip()
      result = result.subsume(skippedResult)
    }

    return result
  }
}

export interface ClaimResultHandler<S> {
  valid(): S
  invalid(error: Failure): S
  skipped(): S
}

type ClaimStatus = "Invalid" | "Valid" | "Skipped"

export abstract class ClaimResult {
  abstract type: ClaimStatus
  public subsumedResults: Array<ClaimResult> = []
  
  constructor(public description: string) {}

  get hasSubsumedResults(): boolean {
    return this.subsumedResults.length > 0
  }

  get summary(): Summary {
    if (this.subsumedResults.length > 0) {
      return this.subsumedResults
        .map(result => result.summary)
        .reduce(combineSummaries, emptySummary())
    } else {
      return this.when({
        valid: () => addValid(emptySummary()),
        invalid: () => addInvalid(emptySummary()),
        skipped: () => addSkipped(emptySummary())
      })
    }
  }

  abstract when<S>(handler: ClaimResultHandler<S>): S
  
  subsume(subResult: ClaimResult): ClaimResult {
    return subResult.when<ClaimResult>({
      valid: () => {
        this.subsumedResults.push(subResult)
        return this
      },
      invalid: () => {
        const result = new InvalidClaim(this.description, { message: "One or more claims are invalid" })
        result.subsumedResults = this.subsumedResults
        result.subsumedResults.push(subResult)
        return result
      },
      skipped: () => {
        this.subsumedResults.push(subResult)
        return this
      }
    })
  }
}


export class ValidClaim extends ClaimResult {
  public type: ClaimStatus = "Valid"

  when<S>(handler: ClaimResultHandler<S>): S {
    return handler.valid()
  }
}

export class InvalidClaim extends ClaimResult {
  public type: ClaimStatus = "Invalid"
  
  constructor (description: string, public error: Failure) {
    super(description)
  }

  when<S>(handler: ClaimResultHandler<S>): S {
    return handler.invalid(this.error)
  }
}

export class SkippedClaim extends ClaimResult {
  public type: ClaimStatus = "Skipped"

  when<S>(handler: ClaimResultHandler<S>): S {
    return handler.skipped()
  }
}