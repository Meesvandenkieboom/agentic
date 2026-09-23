/** Worked examples for the existing KaTeX renderer. Double dollars also delimit inline math. */
export const mathExamples = [
  {
    id: 'preview-quadratic', title: 'Math — quadratic equations', hours: 0.4,
    prompt: 'Solve x² − 5x + 6 = 0 and show the steps, including the quadratic formula.',
    answer: String.raw`## Solve the quadratic

For a quadratic $$ax^2 + bx + c = 0$$, the roots are

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}.
$$

Here, $$a = 1$$, $$b = -5$$, and $$c = 6$$.

### 1. Calculate the discriminant

$$
\Delta = b^2 - 4ac = (-5)^2 - 4(1)(6) = 1.
$$

Since $$\Delta > 0$$, there are **two distinct real roots**.

### 2. Substitute into the formula

$$
\begin{aligned}
x &= \frac{5 \pm \sqrt{1}}{2} \\
  &= \frac{5 \pm 1}{2} \\
  &\in \{2, 3\}.
\end{aligned}
$$

### 3. Check by factoring

$$
x^2 - 5x + 6 = (x-2)(x-3).
$$

**Answer:** $$x = 2$$ or $$x = 3$$. Substituting either value makes the original expression zero.`,
  },
  {
    id: 'preview-calculus', title: 'Math — derivatives & integrals', hours: 0.5,
    prompt: 'Explain the product rule and a definite integral with worked examples.',
    answer: String.raw`## Differentiate a product

Let $$f(x) = x^2\sin x$$. The product rule is

$$
\frac{d}{dx}\bigl[u(x)v(x)\bigr] = u'(x)v(x) + u(x)v'(x).
$$

Applying it gives

$$
\begin{aligned}
f'(x) &= 2x\sin x + x^2\cos x.
\end{aligned}
$$

**Both factors contribute.** Differentiating only one factor misses part of the rate of change.

## Evaluate a definite integral

The area under $$y=x^2$$ between $$x=0$$ and $$x=3$$ is

$$
\int_0^3 x^2\,dx
= \left[\frac{x^3}{3}\right]_0^3
= \frac{27}{3} - 0
= 9.
$$

### A useful connection

Differentiation reverses accumulation. For a continuous function $$g$$,

$$
\frac{d}{dx}\int_a^x g(t)\,dt = g(x).
$$

> The integral gives **9 square units** of area here because the function is nonnegative throughout the interval.`,
  },
  {
    id: 'preview-linear-algebra', title: 'Math — matrices & gradients', hours: 0.6,
    prompt: 'Show a matrix inverse and the gradient of a least-squares loss.',
    answer: String.raw`## Invert a small matrix

Take

$$
A = \begin{bmatrix}2 & 1 \\ 1 & 3\end{bmatrix}.
$$

Its determinant is $$\det(A)=2\cdot3-1\cdot1=5$$, so the matrix is invertible:

$$
A^{-1}=\frac{1}{5}\begin{bmatrix}3 & -1 \\ -1 & 2\end{bmatrix}.
$$

Multiplying $$A A^{-1}$$ gives the identity matrix $$I_2$$.

## Differentiate a least-squares loss

For $$X\in\mathbb{R}^{n\times d}$$, weights $$w\in\mathbb{R}^{d}$$, and targets $$y\in\mathbb{R}^{n}$$, define

$$
L(w)=\frac{1}{n}\lVert Xw-y\rVert_2^2.
$$

The gradient is

$$
\nabla_w L(w)=\frac{2}{n}X^\top(Xw-y).
$$

### Update the weights

A gradient-descent step with learning rate $$\eta>0$$ is

$$
w_{t+1}=w_t-\eta\nabla_w L(w_t).
$$

**Dimension check:** $$X^\top$$ has shape $$d\times n$$ and the residual has shape $$n\times1$$. Their product matches the shape of the weights.`,
  },
  {
    id: 'preview-probability', title: 'Math — Bayes & probability', hours: 0.7,
    prompt: 'An automated check flags defects. Show how the base rate affects a positive result.',
    answer: String.raw`## Start with the base rate

Suppose **2% of manufactured parts are defective**. A check catches 95% of defective parts and incorrectly flags 5% of good parts.

Let $$D$$ mean “defective” and $$+$$ mean “flagged.” Bayes' theorem gives

$$
P(D\mid +)=\frac{P(+\mid D)P(D)}{P(+\mid D)P(D)+P(+\mid\neg D)P(\neg D)}.
$$

Substituting the rates:

$$
P(D\mid +)=\frac{0.95\cdot0.02}{0.95\cdot0.02+0.05\cdot0.98}
=\frac{0.019}{0.068}\approx27.9\%.
$$

### Think in counts

In a batch of **10,000 parts**, the expected counts are:

| Actual condition | Flagged | Not flagged | Total |
| --- | ---: | ---: | ---: |
| Defective | 190 | 10 | 200 |
| Good | 490 | 9,310 | 9,800 |
| **Total** | **680** | **9,320** | **10,000** |

Of the 680 flagged parts, 190 are actually defective.

> **Sensitivity is not the probability that a flagged part is defective.** The underlying defect rate matters too.`,
  },
  {
    id: 'preview-complexity', title: 'Math — sums & time complexity', hours: 0.8,
    prompt: 'Compare linear, binary, and nested-loop algorithms using a table and equations.',
    answer: String.raw`## Count the operations

A scan that visits each of $$n$$ items once takes **linear time**:

$$
T(n)=\sum_{i=1}^{n}1=n\in\Theta(n).
$$

A triangular nested loop visits each pair once:

$$
T(n)=\sum_{i=1}^{n-1}i=\frac{n(n-1)}{2}\in\Theta(n^2).
$$

### Compare growth

| Input size | Linear visits | Pair comparisons |
| ---: | ---: | ---: |
| 10 | 10 | 45 |
| 100 | 100 | 4,950 |
| 1,000 | 1,000 | 499,500 |

## Why binary search scales differently

Each iteration halves the remaining search interval. After $$k$$ halvings, the remaining size is approximately $$n/2^k$$.

$$
\frac{n}{2^k}\leq1
\quad\Longrightarrow\quad
k\geq\log_2 n.
$$

**Binary search takes logarithmic time** on a sorted array with constant-time random access. Sorting the input first has its own cost.

> Doubling the input adds roughly one binary-search step; it roughly quadruples the work of the pairwise comparison loop.`,
  },
];
