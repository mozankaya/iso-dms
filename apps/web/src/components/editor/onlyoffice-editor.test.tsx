import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnlyOfficeEditor } from "./onlyoffice-editor";

interface Instance {
  id: string;
  config: Record<string, unknown>;
  destroyEditor: ReturnType<typeof vi.fn>;
}

let instances: Instance[];
let constructorError: Error | null;

class FakeDocEditor {
  destroyEditor = vi.fn();
  constructor(
    public id: string,
    public config: Record<string, unknown>,
  ) {
    if (constructorError) throw constructorError;
    // The real editor replaces its target element with an iframe
    const target = document.getElementById(id);
    target?.replaceWith(Object.assign(document.createElement("iframe"), { id }));
    instances.push(this);
  }
}

const config = { documentType: "word", document: { key: "k1" }, token: "signed" };

beforeEach(() => {
  instances = [];
  constructorError = null;
  window.DocsAPI = { DocEditor: FakeDocEditor as never };
});

describe("OnlyOfficeEditor", () => {
  it("starts the editor with the signed configuration and fills the available space", () => {
    render(<OnlyOfficeEditor config={config} onError={vi.fn()} />);

    expect(instances).toHaveLength(1);
    expect(instances[0].config).toMatchObject({ ...config, width: "100%", height: "100%" });
    expect(document.getElementById(instances[0].id)).toBeInstanceOf(HTMLIFrameElement);
  });

  it("destroys the editor and empties the container on unmount", () => {
    const { container, unmount } = render(<OnlyOfficeEditor config={config} onError={vi.fn()} />);

    unmount();

    expect(instances[0].destroyEditor).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it("survives strict mode's double mount with exactly one live editor", () => {
    const { container } = render(
      <StrictMode>
        <OnlyOfficeEditor config={config} onError={vi.fn()} />
      </StrictMode>,
    );

    expect(instances).toHaveLength(2);
    expect(instances[0].destroyEditor).toHaveBeenCalledTimes(1);
    expect(instances[1].destroyEditor).not.toHaveBeenCalled();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("recreates the editor when it receives a new configuration", () => {
    const { rerender } = render(<OnlyOfficeEditor config={config} onError={vi.fn()} />);

    rerender(<OnlyOfficeEditor config={{ ...config, token: "other" }} onError={vi.fn()} />);

    expect(instances).toHaveLength(2);
    expect(instances[0].destroyEditor).toHaveBeenCalled();
  });

  it("keeps the running editor when only the callback changes", () => {
    const { rerender } = render(<OnlyOfficeEditor config={config} onError={vi.fn()} />);

    rerender(<OnlyOfficeEditor config={config} onError={vi.fn()} />);

    expect(instances).toHaveLength(1);
    expect(instances[0].destroyEditor).not.toHaveBeenCalled();
  });

  it("reports errors of the editor", () => {
    const onError = vi.fn();
    render(<OnlyOfficeEditor config={config} onError={onError} />);

    const events = instances[0].config.events as { onError: (event: unknown) => void };
    events.onError({ data: { errorCode: -4, errorDescription: "Download failed" } });
    events.onError({});

    expect(onError).toHaveBeenNthCalledWith(1, "Download failed");
    expect(onError).toHaveBeenNthCalledWith(2, "");
  });

  it("reports a failure to start the editor instead of crashing", () => {
    constructorError = new Error("boom");
    const onError = vi.fn();

    expect(() => render(<OnlyOfficeEditor config={config} onError={onError} />)).not.toThrow();

    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("ignores a destroy that fails because the editor is already gone", () => {
    const { unmount } = render(<OnlyOfficeEditor config={config} onError={vi.fn()} />);
    instances[0].destroyEditor.mockImplementation(() => {
      throw new Error("gone");
    });

    expect(() => unmount()).not.toThrow();
  });
});
