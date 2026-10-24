const port=process.env.CALAI_PORT || (process.env.CALAI_RUN_MODE === "hosted-preview" ? process.env.PORT : undefined) || "4310";
const expectedHost=new URL(process.env.CALAI_ORIGIN || `http://127.0.0.1:${port}`).host;
try {
  const response=await fetch(`http://127.0.0.1:${port}/health/ready`,{headers:{Host:expectedHost},signal:AbortSignal.timeout(4000)});
  if(!response.ok) process.exitCode=1;
} catch {
  process.exitCode=1;
}
