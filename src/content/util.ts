export function debounce<T extends (...args: any[]) => void>(fn: T, delay = 150) {
    let t: number | undefined;
    return (...args: Parameters<T>) => {
        if (t) clearTimeout(t);
        // @ts-ignore
        t = setTimeout(() => fn(...args), delay) as unknown as number;
    };
}
