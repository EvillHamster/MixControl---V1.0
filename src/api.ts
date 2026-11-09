export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new ApiError("Не удалось связаться с сервером", 0);
  }
  if (!response.ok) {
    const data = await response
      .json()
      .catch(() => ({ message: "Не удалось связаться с сервером" }));
    if (response.status === 401 && !url.startsWith("/auth/"))
      window.dispatchEvent(new Event("mixcontrol:unauthorized"));
    throw new ApiError(data.message, response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
