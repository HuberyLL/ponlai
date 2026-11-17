# Background: why the method works this way

The reasons behind the rules in [SKILL.md](SKILL.md), and typical cases.

## Why the conditions are fixed

A frame's time depends on everything the GPU does, not only on the page being measured. Each of
these has made a run measure the wrong thing:

- Another client on the GPU. A browser pane hidden from view kept rendering a video and spoiled
  the timings on three separate days. A page in another app's hidden pane once took half the GPU.
  CPU load during a run slowed the GPU too.
- An unpinned setting. A comparison without a fixed pixel ratio voided a pre-merge performance
  check, because the two sides rendered different pixel counts. A dynamic resolution changes the
  pixel count by itself, so the project's profiler pins its render scale for a comparison.
- Timestamp queries. With them on, the browser ran the same frames up to a quarter faster on one
  GPU (the profiler's own notes). So read a frame rate from a run without timestamps, and a split
  by pass from a run with them. Deltas taken in one mode cancel the bias.
- A development build. Unminified code, runtime checks and hot reload change the CPU's share of
  the frame and the timing of the load.

## Why the noise is measured first

Two pages of one build do not measure the same by default. One recorded A/A gave the page opened
last a median frame interval 7 to 17 % longer, outside the 95 % confidence interval, while the GPU
time showed no difference. The page that sat behind the other in the window paced its frames
differently. An A/B had read a build's gain as a loss before the tool was changed to bring each
page to the front while it ran. An earlier form of the same comparison favoured the page loaded
first. Without an A/A, neither bias is visible, and every A/B carries it.

A switch inside one page compares two states under the same load, caches and frame pacing, a few
frames apart. It is the most precise A/B there is, and slow drift cancels when the blocks
alternate (A B B A).

## Why the frame is split by pass, and how

A tile-based GPU starts a pass's vertex work long before the passes it reads have finished. So a
pass's start and end timestamps overlap other passes, and the raw intervals summed to several
times the frame. The profiler instead charges each pass the time it adds to the GPU's timeline.
Even so, one pass's figure can include another pass's work: in one case, the timestamps put the
time on the sea's displacement pass. The check is to switch the pass off and read the total.

Splitting a cost into a fixed part and a per-pixel part tells you which optimisation can work. The
meadow's GPU time was the same at 1440p and at native 4K. It was bound by its vertices, and the
change that saved about a quarter of it removed vertex work, not fragment work.

## Why the gain is proven first

The cheapest stand-in bounds what any optimisation can gain. A flat shader on the vegetation's
coverage draws saved almost as much as hiding them. That showed the cost was fragment shading,
before a depth prepass was built to remove it. In the other direction, an optimisation can come
out byte-identical and save nothing, or its premise can fail at the first cheap measurement.
Either way, the work stops there, before anything is built.

Sweep a quality setting on the rendered image first. Four of the top tier's quality settings were
swept against their original values in the views where each showed the most, and scored with a
perceptual metric. One value finer than the original showed the error that any change of sampling
brings. Each setting took the cheapest value before the error began to rise. Timing only near
that knee saves the long runs.

## Why the rendered output stays the same

If a performance change also changes the rendered image, neither can be judged. The time saved may
come from drawing less, and the image change gets reviewed as a speed-up. Keeping the default path
byte-identical makes the output check a yes or no. A deliberate image change gets its own commit
and its own comparison.

## Why relative numbers

Milliseconds belong to one machine, one driver and one display. A percentage of the frame or of
the pass, with the A/A's spread beside it, carries over to another machine. Results are stated
this way, for example "about a quarter less GPU time", or "no measurable change" in the weathers a
change did not target.

## Sources

- NVIDIA, FLIP (<https://github.com/NVlabs/flip>): its repository describes it as a tool for
  visualising and communicating the errors in rendered images. It is the perceptual metric that
  scored the quality-setting sweeps above.
