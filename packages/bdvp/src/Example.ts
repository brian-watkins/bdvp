import { firstOf } from "./Maybe.js"
import { Reporter, writeComment, writeTestFailure, writeTestPass, writeTestSkip } from "./Reporter.js"
import { addInvalid, addSkipped, addSummary, addValid, emptySummary, Summary } from "./Summary.js"
import { Claim } from "./Claim.js"
import { waitFor } from "./waitFor.js"
import { Effect } from "./Effect.js"
import { Condition } from "./Condition.js"

export interface Example {
  runMode: RunMode
  run(reporter: Reporter): Promise<Summary>
  skip(reporter: Reporter): Promise<Summary>
}

export interface Plan<T> {
  conditions: Array<Condition<T>>
  effects: Array<Effect<T>>
}

export interface Context<T> {
  init: () => T | Promise<T>
  teardown?: (subject: T) => void | Promise<void>
}

export enum RunMode {
  Normal, Skipped, Picked
}

export interface ExampleBuilder<T> {
  build(): Example
}

export interface ExampleSetupBuilder<T> extends ExampleBuilder<T> {
  description(description: string): ExampleScriptBuilder<T>
  script({ assume, observe }: { assume?: Array<Condition<T>>, observe: Array<Effect<T>> }): ExampleScriptsBuilder<T>
}

export interface ExampleScriptBuilder<T> extends ExampleBuilder<T> {
  script({ assume, observe }: { assume?: Array<Condition<T>>, observe: Array<Effect<T>> }): ExampleScriptsBuilder<T>
}

export interface ExampleScriptsBuilder<T> extends ExampleBuilder<T> {
  andThen({ assume, observe }: { assume?: Array<Condition<T>>, observe: Array<Effect<T>> }): ExampleScriptsBuilder<T>
}

export class BDVPExampleBuilder<T> implements ExampleBuilder<T>, ExampleSetupBuilder<T>, ExampleScriptBuilder<T>, ExampleScriptsBuilder<T> {
  private example: BDVPExample<T>

  constructor (public runMode: RunMode, context: Context<T>) {
    this.example = new BDVPExample(runMode, context)
  }

  description(description: string): ExampleScriptBuilder<T> {
    this.example.setDescription(description)
    return this
  }

  script({ assume = [], observe }: { assume?: Array<Condition<T>>, observe: Array<Effect<T>> }): ExampleScriptsBuilder<T> {
    this.example.setPlan({ conditions: assume, effects: observe })
    return this
  }

  andThen({ assume = [], observe }: { assume?: Array<Condition<T>>, observe: Array<Effect<T>> }): ExampleScriptsBuilder<T> {
    this.example.addPlan({ conditions: assume, effects: observe })
    return this
  }

  build(): Example {
    return this.example
  }
}

export class BDVPExample<T> implements Example {
  private _description?: string
  private plans: Array<Plan<T>> = []

  constructor(public runMode: RunMode, public context: Context<T>) { }

  setDescription(description: string) {
    this._description = description
  }

  setPlan(plan: Plan<T>) {
    this.plans = [ plan ]
  }

  addPlan(plan: Plan<T>) {
    this.plans.push(plan)
  }

  async run(reporter: Reporter): Promise<Summary> {
    if (this._description) {
      writeComment(reporter, this._description)
    }

    const subject = await waitFor(this.context.init())

    const state = await this.execute(runNext(subject, this.plans), reporter)

    await waitFor(this.context.teardown?.(subject))

    return state.summary
  }

  async skip(reporter: Reporter): Promise<Summary> {
    if (this._description) {
      writeComment(reporter, this._description)
    }

    const state = await this.execute(skipNext(this.plans), reporter)

    return state.summary
  }

  private async execute(state: ExampleState<T>, reporter: Reporter): Promise<ExampleState<T>> {
    switch (state.type) {
      case "RunNext":
        return firstOf(state.plans).on({
          nothing: async () => {
            return finish(state)
          },
          something: async (plan) => {
            const initialState = verifyConditions(state.subject, plan)
            const planResult = await this.executePlan(initialState, reporter)

            const updated = summarize(state, addSummary(planResult.summary))

            if (planResult.summary.invalid > 0) {
              return this.execute(skipRemainingPlans(updated), reporter)
            }

            return this.execute(runRemaining(updated), reporter)
          }
        })
      case "SkipNext":
        return firstOf(state.plans).on({
          nothing: async () => {
            return finish(state)
          },
          something: async (plan) => {
            const initialState = skipAll([...plan.conditions, ...plan.effects])
            const planResult = await this.executePlan(initialState, reporter)

            const updated = summarize(state, addSummary(planResult.summary))

            return this.execute(skipRemainingPlans(updated), reporter)
          }
        })
      case "Finish":
        return state
    }
  }

  private async executePlan(state: PlanState<T>, reporter: Reporter): Promise<PlanState<T>> {
    switch (state.type) {
      case "Verify":
        return firstOf(state.conditions).on({
          nothing: () => {
            return this.executePlan(allObservations(state), reporter)
          },
          something: async (condition) => {
            const stepResult = await condition.validate(state.subject)
            return stepResult.on({
              valid: () => {
                const updated = summarize(state, addValid)
                writeTestPass(reporter, condition.description)
                return this.executePlan(remainingConditions(updated), reporter)
              },
              invalid: (failure) => {
                const updated = summarize(state, addInvalid)
                writeTestFailure(reporter, condition.description, failure)
                return this.executePlan(skipRemainingClaims(updated), reporter)
              }
            })
          }
        })
      case "Observe":
        return firstOf(state.effects).on({
          nothing: () => {
            return this.executePlan(complete(state), reporter)
          },
          something: async (effect) => {
            const observationResult = await effect.validate(state.subject)
            return observationResult.on({
              valid: () => {
                const updated = summarize(state, addValid)
                writeTestPass(reporter, effect.description)
                return this.executePlan(remainingObservations(updated), reporter)
              },
              invalid: (failure) => {
                const updated = summarize(state, addInvalid)
                writeTestFailure(reporter, effect.description, failure)
                return this.executePlan(remainingObservations(updated), reporter)
              }
            })
          }
        })
      case "Skip":
        return firstOf(state.claims).on({
          nothing: () => {
            return this.executePlan(complete(state), reporter)
          },
          something: (claim) => {
            writeTestSkip(reporter, claim.description)
            const updated = summarize(state, addSkipped)
            return this.executePlan(skipRemaining(updated), reporter)
          }
        })
      case "Complete":
        return state
    }
  }
}

type ExampleState<T>
  = RunNext<T>
  | SkipNext<T>
  | Finish

interface Finish {
  type: "Finish",
  summary: Summary
}

function finish<T>(state: ExampleState<T>): Finish {
  return {
    type: "Finish",
    summary: state.summary
  }
}

interface RunNext<T> {
  type: "RunNext",
  subject: T,
  plans: Array<Plan<T>>
  summary: Summary
}

function runNext<T>(subject: T, plans: Array<Plan<T>>): RunNext<T> {
  return {
    type: "RunNext",
    subject,
    plans,
    summary: emptySummary()
  }
}

function runRemaining<T>(state: RunNext<T>): RunNext<T> {
  return {
    type: "RunNext",
    subject: state.subject,
    plans: state.plans.slice(1),
    summary: state.summary
  }
}

interface SkipNext<T> {
  type: "SkipNext",
  plans: Array<Plan<T>>
  summary: Summary
}

function skipNext<T>(plans: Array<Plan<T>>): SkipNext<T> {
  return {
    type: "SkipNext",
    plans,
    summary: emptySummary()
  }
}

function skipRemainingPlans<T>(state: { plans: Array<Plan<T>>, summary: Summary }): SkipNext<T> {
  return {
    type: "SkipNext",
    plans: state.plans.slice(1),
    summary: state.summary
  }
}

type PlanState<T>
  = Skip<T>
  | Verify<T>
  | Observe<T>
  | Complete

interface Skip<T> {
  type: "Skip",
  summary: Summary,
  claims: Array<Claim<T>>
}

function skipAll<T>(claims: Array<Claim<T>>): Skip<T> {
  return {
    type: "Skip",
    claims: claims,
    summary: emptySummary()
  }
}

function skipRemainingClaims<T>(current: Verify<T>): Skip<T> {
  return {
    type: "Skip",
    claims: [ ...current.conditions.slice(1), ...current.plan.effects ],
    summary: current.summary
  }
}

function skipRemaining<T>(current: Skip<T>): Skip<T> {
  return {
    type: "Skip",
    claims: current.claims.slice(1),
    summary: current.summary
  }
}

interface Verify<T> {
  type: "Verify"
  subject: T,
  plan: Plan<T>,
  summary: Summary,
  conditions: Array<Claim<T>>
}

function verifyConditions<T>(subject: T, plan: Plan<T>): Verify<T> {
  return {
    type: "Verify",
    subject: subject,
    plan: plan,
    conditions: plan.conditions,
    summary: emptySummary()
  }
}

function remainingConditions<T>(current: Verify<T>): Verify<T> {
  return {
    type: "Verify",
    subject: current.subject,
    plan: current.plan,
    conditions: current.conditions.slice(1),
    summary: current.summary
  }
}

interface Observe<T> {
  type: "Observe"
  subject: T,
  plan: Plan<T>,
  summary: Summary,
  effects: Array<Claim<T>>
}

function allObservations<T>(current: Verify<T>): Observe<T> {
  return {
    type: "Observe",
    effects: current.plan.effects,
    subject: current.subject,
    plan: current.plan,
    summary: current.summary
  }
}

function remainingObservations<T>(current: Observe<T>): Observe<T> {
  return {
    type: "Observe",
    effects: current.effects.slice(1),
    subject: current.subject,
    plan: current.plan,
    summary: current.summary
  }
}

interface Complete {
  type: "Complete"
  summary: Summary
}

function complete<T>(model: PlanState<T>): Complete {
  return { type: "Complete", summary: model.summary }
}

function summarize<T extends { summary: Summary }>(summarizable: T, summarizer: (summary: Summary) => Summary): T {
  return { ...summarizable, summary: summarizer(summarizable.summary) }
}