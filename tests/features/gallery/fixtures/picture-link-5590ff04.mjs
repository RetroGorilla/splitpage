


const OPENED_FROM_ITS_VIEW               = { enabled: true, visible: false };



function fields(id        , input         , strings                   , numbers                    = [])         {
  if (typeof input !== "object" || input === null) throw new TypeError(`${id} needs what to open`);
  const record = input          ;
  for (const key of strings) {
    if (typeof record[key] !== "string") throw new TypeError(`${id} needs ${key} as text`);
  }
  for (const key of numbers) {
    if (typeof record[key] !== "number") throw new TypeError(`${id} needs ${key} as a number`);
  }
  return record;
}

function opener(id        , label        , run                          )                   {
  return {
    id,
    label,
    group: "Open",
    availability: () => OPENED_FROM_ITS_VIEW,
    run: (_source, input) => { run(input); }
  };
}

export function editorOpenActions(openGalleryLink                           )                     {
  return [
    opener("open-picture-link", "Open picture link", (input) => {
      const at = fields("open-picture-link", input, ["rowId"], ["slot"]);
      openGalleryLink(at["rowId"]          , at["slot"]          , at["key"]);
    })
  ];
}
