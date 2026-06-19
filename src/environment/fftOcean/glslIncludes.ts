export const COMPLEX_GLSL = /* glsl */ `
vec2 complexMultiply(vec2 a, vec2 b) {
    return vec2(
        a.x * b.x - a.y * b.y,
        a.x * b.y + a.y * b.x
    );
}

vec2 complexExp(float theta) {
    return vec2(cos(theta), sin(theta));
}

vec2 complexConjugate(vec2 a) {
    return vec2(a.x, -a.y);
}
`

export const RANDOM_GLSL = /* glsl */ `
float hash(vec2 uv) {
    return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec2 gaussianRandom(vec2 uv) {
    float u1 = hash(uv);
    float u2 = hash(uv + vec2(1.234, 5.678));
    u1 = max(1e-6, u1);
    float radius = sqrt(-2.0 * log(u1));
    float theta = 2.0 * 3.14159265359 * u2;
    return vec2(radius * cos(theta), radius * sin(theta));
}
`

export const FRESNEL_GLSL = /* glsl */ `
float calculateFresnel(vec3 viewDir, vec3 normal, float f0, float f90) {
    float cosTheta = max(dot(viewDir, normal), 0.0);
    return f0 + (f90 - f0) * pow(1.0 - cosTheta, 5.0);
}
`