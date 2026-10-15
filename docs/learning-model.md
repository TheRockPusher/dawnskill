# Learning model: every number and rule, with sources

This document specifies the constants and rules that `@dawnskill/core` implements. Each rule cites a primary source or is labelled **product heuristic**. A product heuristic is a design choice, and we may change it. Citations were checked against Crossref/DOI or the publisher's page on 2026-10-16.

## 1. Skill levels (Dreyfus 1–5, plus product level 0)

**Rule.** A skill level is an integer `0..5`. Levels 1–5 are the five Dreyfus stages. Level 0, "no exposure", is a product extension and **not a Dreyfus stage**. It exists only as a self-rating value: requirements and learning steps always target `1..5`. A gap exists when `required > current`. An *unassessed* skill (`level: null`, no rating yet) blocks a task exactly like a gap. Approving a plan requires the user to self-rate every new skill in it, and the anchors below are shown while they do.

| Level | Dreyfus stage | Self-assessment anchor for a software developer ("I…") | Typical evidence |
|---|---|---|---|
| 0 | *(none; product)* | I have never used or studied this. | — |
| 1 | Novice | I need step-by-step instructions or a tutorial to get anything working, and I follow rules without knowing when they do not apply. | Tutorial exercise reproduced |
| 2 | Advanced beginner | I can do familiar tasks alone by adapting examples, but I get stuck when the situation differs from ones I have seen, and I can't yet tell which details matter. | Small exercise solved without a walkthrough |
| 3 | Competent | I can plan and deliver a non-trivial feature on my own: I choose the approach deliberately and debug my own mistakes, though it takes conscious effort. | Working feature, merged PR |
| 4 | Proficient | In unfamiliar code I see quickly what matters or what is wrong, then reason out what to do. I catch problems in other people's reviews. | Substantive review comments, a fix in an unfamiliar codebase |
| 5 | Expert | I usually know what to do without deliberating. I handle novel edge cases, design idiomatic APIs, and can explain when the usual rules break. | Design or API others adopt, teaching material |

The anchors paraphrase the stage descriptions (rules without context → recognised situational aspects → a chosen plan with responsibility for it → seeing the situation intuitively while still deciding analytically → intuitive seeing and doing) in a developer's terms. The first-person wording is ours.

**Invariant rules.**
- Levels are per skill. A level in one skill implies nothing about any other skill. Expertise is domain-specific: Ericsson & Lehmann 1996, and Dreyfus 2004 applies the stages per skill domain.
- A level is never inferred from task speed. Speed is confounded with task difficulty and estimate error (§7). **Product rule**; kernel invariant K1 in PLAN.md.
- Only a user event changes a level: a self-rating, or `UserConfirmed` on an evidence-backed proposal (§8).

**Sources.** Dreyfus & Dreyfus 1980, [doi:10.21236/ADA084551](https://doi.org/10.21236/ADA084551) ([DTIC](https://apps.dtic.mil/sti/citations/ADA084551)). Benner 1982, *AJN* 82(3), [doi:10.1097/00000446-198282030-00004](https://doi.org/10.1097/00000446-198282030-00004). Benner 1984, *From Novice to Expert*, Addison-Wesley ([catalogue](https://catalog.hathitrust.org/Record/003516660)). Dreyfus 2004, [doi:10.1177/0270467604264992](https://doi.org/10.1177/0270467604264992). Ericsson & Lehmann 1996, [doi:10.1146/annurev.psych.47.1.273](https://doi.org/10.1146/annurev.psych.47.1.273).

**Limits.** The Dreyfus model is a phenomenological description, not a psychometric scale. It was developed from studies of pilots, chess players, drivers and language learners, and Benner applied it to nurses. The stages are ordinal, so the distances between levels are not equal and level numbers must not be averaged. The developer anchors are ours and have not been validated.

## 2. Skill granularity

**Rule.** A skill must be narrow enough that one level step (current → current + 1) can be reached through focused practice on **one concrete deliverable**. Every level step is one learning task. A gap of k levels becomes k chained learning tasks, each blocking the next; the last one blocks the task that needs the skill.

| Constant | Value | Status |
|---|---|---|
| `Skill.practiceMinutes` (planner estimate of focused minutes per level step), validated range | 5..2400 | product heuristic: a sanity bound against nonsense values, not a pedagogical claim |
| Planner guidance: maximum minutes per level step | 480 (8 h) | product heuristic |

If a step would take more than 480 min, the skill is too broad. The planner should split it into narrower skills linked by `prerequisites`. The planner prompt enforces this; the kernel only enforces the 5..2400 range.

**Basis.** In 4C/ID, training is organised around whole tasks arranged in task classes from simple to complex. Each class is a manageable step, and separate part-task practice is used only for recurrent skills that must become automatic (van Merriënboer, Clark & de Croock 2002). Cognitive load theory explains why the step must be small: working memory is limited, and problem solving with too many interacting elements leaves no capacity for learning (Sweller 1988, [doi:10.1207/s15516709cog1202_4](https://doi.org/10.1207/s15516709cog1202_4); van Merriënboer, Kirschner & Kester 2003). A step needs one concrete deliverable because each 4C/ID learning task is a whole, authentic task.

**Basis for 480 min (product heuristic; no source gives this number).** We assume the target user is a working developer. 480 min is one working day; a bigger step cannot be finished as one focused deliverable and should be split.

**Naming.** Display name `<technology/domain>: <capability>`, e.g. `Rust: ownership & borrowing`. The key is lowercase kebab-case, e.g. `rust-ownership-borrowing`. It must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and be at most 64 characters (**product rule**). One key is one skill. The planner reuses existing keys whenever a skill is already known, so learning and levels accumulate across goals.

## 3. Learning activity per target level

**Rule.** The activity depends on the **target** level of the step. The more expertise the learner has, the less guidance the activity gives. This follows the expertise reversal effect: guidance that helps novices becomes redundant, or even harmful, for more experienced learners (Kalyuga, Ayres, Chandler & Sweller 2003).

| Target | `activity` | Instruction (one sentence, shown to the user) | Source |
|---|---|---|---|
| L1 | `worked-examples` | Study complete worked examples of the capability, then reproduce one yourself and explain each step in your own words. | Sweller & Cooper 1985 |
| L2 | `guided-practice` | Work through examples with more steps left out each time, filling in the missing steps yourself, until you solve a new variant unaided. | Renkl & Atkinson 2003; Atkinson, Renkl & Merrill 2003 |
| L3 | `independent-project` | Build a small but complete piece of work that uses the skill in a realistic setting, without a tutorial, and debug it yourself. | Kalyuga et al. 2003; van Merriënboer et al. 2002 |
| L4 | `varied-cases` | Apply the skill to several deliberately different cases (inputs, constraints, codebases), aimed at your weak spots, and get immediate feedback (tests, review, benchmarks) on each. | Ericsson, Krampe & Tesch-Römer 1993; variability of practice in van Merriënboer et al. 2002 |
| L5 | `teach-and-extend` | Explain the skill to others (write-up, talk or code review) and extend it past the documented path, including the cases where the usual rules break. | Fiorella & Mayer 2013 |

**Deliverable.** `LearningSpec.deliverable` is free text. It names the application-ready artifact that proves the step and the task it unblocks (§4). It is not an enum.

**Sources.** Sweller & Cooper 1985, [doi:10.1207/s1532690xci0201_3](https://doi.org/10.1207/s1532690xci0201_3). Renkl & Atkinson 2003, [doi:10.1207/S15326985EP3801_3](https://doi.org/10.1207/S15326985EP3801_3). Atkinson, Renkl & Merrill 2003, [doi:10.1037/0022-0663.95.4.774](https://doi.org/10.1037/0022-0663.95.4.774). Kalyuga et al. 2003, [doi:10.1207/S15326985EP3801_4](https://doi.org/10.1207/S15326985EP3801_4). Ericsson et al. 1993, [doi:10.1037/0033-295X.100.3.363](https://doi.org/10.1037/0033-295X.100.3.363). Fiorella & Mayer 2013, [doi:10.1016/j.cedpsych.2013.06.001](https://doi.org/10.1016/j.cedpsych.2013.06.001) (actually teaching beat merely expecting to teach on a delayed test).

**Limits.**
- Each effect was shown in a specific setting: worked examples with algebra and geometry students, learning by teaching with short science texts, deliberate practice with musicians.
- The fixed L1→L5 mapping is our discretisation of a continuum: **product heuristic**.
- Deliberate practice explains far less variance than popular accounts suggest: 26% in games, 4% in education and under 1% in professions (Macnamara, Hambrick & Oswald 2014, [doi:10.1177/0956797614535810](https://doi.org/10.1177/0956797614535810)).
- An L5 learning task consolidates expertise; it does not create it. Expertise comes from years of experience, and the level still changes only on confirmed evidence.

## 4. Just-in-time learning tied to an application

**Rule.** A learning task exists only because some task requires the skill. There is no speculative curriculum. The link is a dependency edge: the learning task blocks the task that needs the skill. Its free-text `deliverable` (§3) names an application-ready artifact set in that task's context. Example: "a prototype of the `--glob` matcher function, reused in the ripgrep fix", not "a generic Rust exercise".

**Basis.** 4C/ID presents supportive information when it is needed for a task class, and procedural information just in time, at the moment a step is performed (van Merriënboer, Clark & de Croock 2002). Presenting information just in time reduces extraneous cognitive load and improved performance in a controlled study (Kester, Kirschner, van Merriënboer & Bäumer 2001, [doi:10.1016/S0747-5632(01)00011-5](https://doi.org/10.1016/S0747-5632(01)00011-5)). See also van Merriënboer, Kirschner & Kester 2003, [doi:10.1207/S15326985EP3801_2](https://doi.org/10.1207/S15326985EP3801_2), and *Ten Steps to Complex Learning*, [doi:10.4324/9781315113210](https://doi.org/10.4324/9781315113210).

**Limits.** The just-in-time studies time *information presentation* within one training session. Extending this to "schedule whole learning tasks only when a real task needs them, and make their output reusable there" is our interpretation: **product heuristic**.

## 5. Retrieval practice and spaced review

**Rule.**
- Every skill carries **2–4 retrieval prompts** (`retrievalPrompts`; **product heuristic**: enough to cover the key concepts while keeping a review under a few minutes).
- A prompt must ask the user to produce an answer (recall, write, explain), not recognise one.
- Reviews are **per skill**. A skill enters review once it has at least one `done` learning task. One review shows all of the skill's retrieval prompts. The user grades the whole review as `recalled` or `forgot` (`ReviewRecorded`).

| Situation | Next review after |
|---|---|
| first learning task for the skill done, no review yet | 1 day |
| n-th consecutive `recalled` (n = 1, 2, 3, …) | I(n+1): 6, 15, 38, 95, 238, 595, … days |
| `forgot` | 1 day; the streak resets to 0 |

Here I(1) = 1, I(2) = 6, and `I(k) = ceil(I(k−1) × 2.5)` in whole days for k > 2. The due date is the time of the last review (or of the first learning-task completion) plus the interval, with the clock injected.

**Why this is exactly SM-2 restricted to two grades.** SM-2 sets I(1)=1, I(2)=6, I(n)=I(n−1)·EF with initial EF=2.5, and rounds fractional intervals up. Its EF update `EF' = EF + (0.1 − (5−q)(0.08 + (5−q)·0.02))` leaves EF unchanged at q=4. For q<3 it restarts the repetitions *without changing EF* (Wozniak 1990, [SM-2 description](https://super-memory.com/english/ol/sm2.htm)). So if `recalled` = q=4 and `forgot` = q<3, EF stays at 2.5 forever. Anki's legacy SM-2 scheduler also defaults its starting ease to 2.50 ([Anki manual: Starting Ease](https://docs.ankiweb.net/deck-options.html); [Anki FAQ: SM-2](https://docs.ankiweb.net/faqs/what-spaced-repetition-algorithm)).

**Evidence.** Testing yourself improves retention at a 1-week delay more than restudying, although restudying wins at 5 minutes (Roediger & Karpicke 2006, [doi:10.1111/j.1467-9280.2006.01693.x](https://doi.org/10.1111/j.1467-9280.2006.01693.x)). Spaced study beats massed study across hundreds of comparisons (Cepeda, Pashler, Vul, Wixted & Rohrer 2006, [doi:10.1037/0033-2909.132.3.354](https://doi.org/10.1037/0033-2909.132.3.354)). The best gap grows with the retention interval, from about 20–40% of a 1-week delay down to about 5–10% of a 1-year delay. Expanding intervals follow that trend (Cepeda, Vul, Rohrer, Wixted & Pashler 2008, [doi:10.1111/j.1467-9280.2008.02209.x](https://doi.org/10.1111/j.1467-9280.2008.02209.x)).

**Simplifications (deliberate).**
- One schedule per skill, not per prompt. SM-2 step 1 splits knowledge into the smallest items; we keep the skill as the unit so the review count stays small.
- No per-item easiness: hard skills are not reviewed more often.
- No q=3/q=5 grades.
- No SM-2 step 7 (re-drilling failed items the same day).
- No maximum interval.
- No modern scheduler such as FSRS.
- Cepeda's data come from verbal facts, not programming skills; reviews maintain the key ideas and are not evidence of a level.

## 6. Priority: weighted sum (SAW) with ROC weights

**Criteria**, for each open task t (status not `done`/`cancelled`):

| Criterion | Raw value | Direction | Normalisation `n(t) ∈ [0,1]` |
|---|---|---|---|
| importance | user Likert 1–5 | benefit | `(x − 1) / 4` |
| urgency | user Likert 1–5 | benefit | `(x − 1) / 4` |
| unblocks | number of open tasks that transitively depend on t | benefit | `(x − min) / (max − min)` |
| effort | estimated minutes (§7 calibrated; ≥ 1, validated at input) | cost | `(max ln E − ln E_t) / (max ln E − min ln E)` |
| age | `floor((now − createdAt) / 1 day)` | benefit | `(x − min) / (max − min)` |

min/max are taken over the current open tasks. **If max = min, the normalised value is 0 for every task.**

**Score.** `S(t) = Σ_i w_i · n_i(t)`, so `S ∈ [0,1]`. This is simple additive weighting (Hwang & Yoon 1981, [doi:10.1007/978-3-642-48318-9](https://doi.org/10.1007/978-3-642-48318-9)).

**Weights: Rank-Order Centroid.** The user ranks the 5 criteria. The criterion at rank i gets `w_i = (1/n) · Σ_{k=i}^{n} 1/k` (Barron & Barrett 1996, [doi:10.1287/mnsc.42.11.1515](https://doi.org/10.1287/mnsc.42.11.1515)). ROC is the centroid of all weight vectors consistent with the ranking. In their simulations it chose the best alternative more often than rank-sum or rank-reciprocal weights. Code uses the exact fractions:

| Rank | Default criterion | Exact | 4 d.p. |
|---|---|---|---|
| 1 | importance | 137/300 | 0.4567 |
| 2 | urgency | 77/300 | 0.2567 |
| 3 | unblocks | 47/300 | 0.1567 |
| 4 | effort | 27/300 | 0.0900 |
| 5 | age | 12/300 | 0.0400 |

The weights sum to exactly 1. The 4-d.p. values sum to 1.0001 because of rounding.

**Rationale for the default ranking.**
- **Importance > urgency.** People tend to choose urgent tasks over more important ones even when the important task pays more (the "mere urgency effect"; Zhu, Yang & Hsee 2018, *J. Consumer Research*, [doi:10.1093/jcr/ucy008](https://doi.org/10.1093/jcr/ucy008)). Ranking importance first corrects for that bias.
- **Unblocks third.** Finishing a task that others wait on releases more work. That is structural value, but it is secondary to what the user values.
- **Effort fourth.** Among tasks of similar value, the shorter one first lowers total weighted waiting time, as in Smith's weighted shortest processing time rule (Smith 1956, [doi:10.1002/nav.3800030106](https://doi.org/10.1002/nav.3800030106)).
- **Age last.** It exists only so old tasks eventually surface (anti-starvation, by analogy to aging in OS schedulers): **product heuristic**.

The ordering itself, and putting effort on a log scale, are **product heuristics**. The log scale means doubling the effort costs the same at any size: 30→60 min counts the same as 4→8 h.

**Effective priority.** A learning task is valuable because of the work it unblocks.
- `eff(t) = max({S(t)} ∪ {S(d) : d open and transitively blocked by t})`. Equivalently, `eff(t) = max(S(t), max over open direct dependents d of eff(d))`.
- This is priority inheritance: a blocker runs at the priority of the most important task waiting on it (Sha, Rajkumar & Lehoczky 1990, [doi:10.1109/12.57058](https://doi.org/10.1109/12.57058)).
- Ready tasks sort by `eff` desc, then `S` desc, then `createdAt` asc, then `id` asc (deterministic).
- `unblocks` counts how many tasks wait (breadth). Inheritance carries the value of the most valuable waiting task (depth).

**Limits.**
- SAW assumes the criteria are preferentially independent and lets a strength in one compensate for a weakness in another.
- Min–max normalisation depends on the current set of open tasks, so adding a task can reverse the order of two others.
- ROC assumes every weight vector consistent with the ranking is equally likely. It does not measure the user's actual trade-offs.

## 7. Duration estimates: reference class (outside view)

**Rule.** Each task has a planner `category`, and its raw estimate `e` (whole minutes, > 0) is stored unchanged. For category c, take the `done` completion rows with `actualMinutes > 0`. Untracked rows (`null`) and `cancelled` rows are excluded. Each row stores the estimate and category it had when it closed, so later edits do not rewrite history.

- ratios `r_j = actual_j / estimate_j`; `n_c` = their count
- if `n_c ≥ 3`: `calibrated = max(1, ceil(e × median(r)))` minutes; otherwise `calibrated = e`
- report `n_c` and `MAD = median(|r_j − median(r)|)`, unscaled
- median of an even count = mean of the two middle values

The ratio is applied **once**, when reading the estimate. A calibrated value is never stored as a new raw estimate, so corrections cannot compound. Learning tasks use the category `learning`, so their history refines `practiceMinutes`-based estimates.

**Basis.** The outside view predicts from the distribution of outcomes in a reference class of similar past cases, instead of the specifics of the case at hand (Kahneman & Tversky 1979, reprinted 1982, [doi:10.1017/CBO9780511809477.031](https://doi.org/10.1017/CBO9780511809477.031); Kahneman & Lovallo 1993, [doi:10.1287/mnsc.39.1.17](https://doi.org/10.1287/mnsc.39.1.17)). Flyvbjerg 2006 ([doi:10.1177/875697280603700302](https://doi.org/10.1177/875697280603700302)) turns this into reference-class forecasting: apply the uplift observed in the class to the raw estimate. Our median ratio is the class's P50 uplift. People underestimate their own task durations even with experience of past overruns (Buehler, Griffin & Ross 1994, [doi:10.1037/0022-3514.67.3.366](https://doi.org/10.1037/0022-3514.67.3.366)). The median and MAD are robust to outliers (Leys et al. 2013, [doi:10.1016/j.jesp.2013.03.013](https://doi.org/10.1016/j.jesp.2013.03.013)).

**Limits.** `n ≥ 3` is a **pragmatic minimum (product heuristic)**: it is the smallest sample whose median ignores a single extreme value, not a statistically adequate sample. Flyvbjerg's reference classes contain dozens to hundreds of projects. Showing `n` and the MAD lets the user judge how reliable the correction is. Category labels come from the LLM, so the reference classes can be noisy.

## 8. What we deliberately do not claim

- **No learning-hours-per-level constants.** There is no "N hours to reach level k". Time to a level varies widely, and deliberate-practice hours explain little of the variance in professions (Macnamara et al. 2014). Each step's effort is estimated per task and calibrated as in §7.
- **No automatic promotion.** Completing a learning task, finishing tasks quickly or passing a review never changes a level. The system only *proposes* a change with evidence attached, and the user confirms it (K1).
- **Self-assessment is miscalibrated.** Kruger & Dunning 1999 ([doi:10.1037/0022-3514.77.6.1121](https://doi.org/10.1037/0022-3514.77.6.1121)) found low performers overestimate themselves. Later work attributes much of that pattern to regression to the mean and measurement artefacts (Nuhfer et al. 2016, [doi:10.5038/1936-4660.9.1.4](https://doi.org/10.5038/1936-4660.9.1.4); Gignac & Zajenkowski 2020, [doi:10.1016/j.intell.2020.101449](https://doi.org/10.1016/j.intell.2020.101449)). Either way, self-ratings correlate only moderately with performance: mean r ≈ .29 across 22 meta-analyses (Zell & Krizan 2014, [doi:10.1177/1745691613518075](https://doi.org/10.1177/1745691613518075)). Mitigations:
  - ratings use behavioural anchors (§1), not adjectives like "intermediate";
  - each proposal shows its evidence (§3 deliverables);
  - the user stays the authority.
- **No validated pedagogy for developers.** §3–§5 transfer laboratory findings to self-directed software learning. They are reasoned defaults that we measure against the Phase 0 gate, not proven outcomes.
